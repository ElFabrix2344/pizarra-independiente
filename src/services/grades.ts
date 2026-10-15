// Registro de notas del ciclo.
// Reglas (Reglamento de Estudios de Pregrado UP 2023, art. 28–30 y anexo):
//  - Escala vigesimal 0–20; se aprueba una asignatura con 11 como mínimo.
//  - Calificación por asignatura (CA): combinación ponderada de las notas parciales;
//    la fracción desde 0.5 sube a la unidad inmediata superior.
//  - Calificación por semestre (CS) y acumulada (CAc): Σ(CA × créditos) / Σ créditos,
//    con dos decimales sin redondear (se trunca). Las asignaturas REC/NREC no cuentan.
// Los datos viven en KV, un libro por ciclo: "grades:<inicio del ciclo>". Ajustar la fecha de inicio
// unas semanas mueve el libro a la nueva fecha; una fecha de otro ciclo empieza un libro nuevo.

import { ApiError } from '../lib/http';

export const PASSING = 11;
const MAX_ITEMS = 30;

export interface GradeItem {
  id: string;
  name: string;
  /** Porcentaje 0–100. */
  weight: number;
  /** Nota 0–20, o null si aún no la tienes. */
  grade: number | null;
}

export interface CourseGrades {
  credits: number | null;
  /** false para cursos que no entran al ponderado (REC/NREC, p. ej. EFE). */
  academic: boolean;
  /** Nota meta (entera) opcional. */
  target: number | null;
  items: GradeItem[];
}

export interface GradeBook {
  cycleStart: string;
  courses: Record<string, CourseGrades>;
  /** Acumulado antes de este ciclo, para proyectar el nuevo. */
  prior: { average: number | null; credits: number | null };
}

// ---------- cálculo ----------

/** Desde .5 sube al entero siguiente (con margen para errores de coma flotante). */
export const roundHalfUp = (x: number) => Math.floor(x + 0.5 + 1e-9);
/** Dos decimales sin redondear. */
export const trunc2 = (x: number) => Math.floor(x * 100 + 1e-9) / 100;

export type NeedStatus = 'done' | 'secured' | 'possible' | 'impossible';

export interface Need {
  target: number;
  status: NeedStatus;
  /** Promedio necesario en lo que falta (solo si status = possible). */
  average: number | null;
}

export interface CourseSummary {
  name: string;
  credits: number | null;
  academic: boolean;
  target: number | null;
  items: GradeItem[];
  totalWeight: number;
  gradedWeight: number;
  remainingWeight: number;
  /** Puntos ya ganados sobre 20 (Σ peso × nota). */
  earned: number;
  /** Promedio de lo evaluado, o null si no hay notas. */
  average: number | null;
  /** CA si todo sigue al promedio actual (o la final si ya está todo). */
  projected: number | null;
  /** CA final si ya están todas las notas. */
  final: number | null;
  /** Rango posible de la nota (sin redondear): 0 en lo que falta → 20 en lo que falta. */
  min: number;
  max: number;
  pass: Need;
  goal: Need | null;
  weightWarning: string | null;
}

export function need(target: number, earned: number, remainingWeight: number, allGraded: boolean): Need {
  const threshold = target - 0.5; // la CA redondea desde .5
  if (allGraded) return { target, status: earned + 1e-9 >= threshold ? 'done' : 'impossible', average: null };
  if (earned + 1e-9 >= threshold) return { target, status: 'secured', average: null };
  const avg = (threshold - earned) / (remainingWeight / 100);
  if (avg > 20 + 1e-9) return { target, status: 'impossible', average: null };
  return { target, status: 'possible', average: Math.ceil(avg * 10 - 1e-9) / 10 };
}

export function summarizeCourse(name: string, c: CourseGrades): CourseSummary {
  const totalWeight = round2(c.items.reduce((a, i) => a + i.weight, 0));
  const graded = c.items.filter((i) => i.grade !== null);
  const gradedWeight = round2(graded.reduce((a, i) => a + i.weight, 0));
  const earned = graded.reduce((a, i) => a + (i.weight / 100) * (i.grade as number), 0);
  const remainingWeight = round2(Math.max(0, 100 - gradedWeight));
  const allGraded = c.items.length > 0 && graded.length === c.items.length && Math.abs(totalWeight - 100) < 0.01;
  const average = gradedWeight > 0 ? earned / (gradedWeight / 100) : null;
  const final = allGraded ? roundHalfUp(earned) : null;
  const projected = final ?? (average !== null ? roundHalfUp(average) : null);
  let weightWarning: string | null = null;
  if (c.items.length && Math.abs(totalWeight - 100) >= 0.01) {
    weightWarning = totalWeight < 100 ? `Los pesos suman ${totalWeight} %: falta ${round2(100 - totalWeight)} %.` : `Los pesos suman ${totalWeight} %: sobra ${round2(totalWeight - 100)} %.`;
  }
  return {
    name,
    credits: c.credits,
    academic: c.academic,
    target: c.target,
    items: c.items,
    totalWeight,
    gradedWeight,
    remainingWeight,
    earned: round2(earned),
    average: average === null ? null : round2(average),
    projected,
    final,
    min: round2(earned),
    max: round2(earned + (remainingWeight / 100) * 20),
    pass: need(PASSING, earned, remainingWeight, allGraded),
    goal: c.target && c.target > PASSING ? need(c.target, earned, remainingWeight, allGraded) : null,
    weightWarning,
  };
}

export interface SemesterSummary {
  /** Ponderado del semestre proyectado (CS), o null si no hay cursos con nota y créditos. */
  semester: number | null;
  /** Créditos que entran a la proyección. */
  credits: number;
  /** Cursos académicos que aún no entran (sin créditos o sin notas). */
  missing: Array<{ name: string; reason: 'credits' | 'grades' }>;
  /** Acumulado proyectado (CAc) con el acumulado anterior, o null. */
  cumulative: number | null;
}

export function summarizeSemester(courses: CourseSummary[], prior: GradeBook['prior']): SemesterSummary {
  let points = 0;
  let credits = 0;
  const missing: SemesterSummary['missing'] = [];
  for (const c of courses) {
    if (!c.academic) continue;
    if (!c.credits) { missing.push({ name: c.name, reason: 'credits' }); continue; }
    if (c.projected === null) { missing.push({ name: c.name, reason: 'grades' }); continue; }
    points += c.projected * c.credits;
    credits += c.credits;
  }
  const semester = credits ? trunc2(points / credits) : null;
  const cumulative =
    credits && prior.average !== null && prior.credits
      ? trunc2((prior.average * prior.credits + points) / (prior.credits + credits))
      : null;
  return { semester, credits, missing, cumulative };
}

function round2(x: number) {
  return Math.round(x * 100) / 100;
}

// ---------- almacenamiento ----------

export class GradeStore {
  constructor(private readonly kv: KVNamespace) {}
  private key(cycleStart: string) {
    return `grades:${cycleStart}`;
  }
  async get(cycleStart: string): Promise<GradeBook> {
    const b = await this.kv.get<GradeBook>(this.key(cycleStart), 'json');
    return { cycleStart, courses: b?.courses ?? {}, prior: b?.prior ?? { average: null, credits: null } };
  }
  put(book: GradeBook) {
    return this.kv.put(this.key(book.cycleStart), JSON.stringify(book));
  }

  /**
   * Al cambiar el inicio del ciclo de `from` a `to`:
   *  - "moved": era un ajuste (≤ SAME_CYCLE_DAYS) y el libro pasó a la nueva fecha (se mueve, no se copia,
   *    para que volver a la fecha anterior no muestre una copia vieja).
   *  - "new": es otro ciclo; Notas empieza vacío y el libro anterior queda guardado con su fecha.
   *  - "none": nada que hacer (misma fecha, sin libro anterior, o la nueva fecha ya tiene el suyo).
   */
  async followCycle(from: string, to: string): Promise<'moved' | 'new' | 'none'> {
    if (from === to) return 'none';
    const [oldRaw, newRaw] = await Promise.all([this.kv.get(this.key(from)), this.kv.get(this.key(to))]);
    if (!oldRaw || newRaw) return 'none';
    const days = Math.abs(Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 864e5;
    if (!(days <= SAME_CYCLE_DAYS)) return 'new';
    const book = JSON.parse(oldRaw) as GradeBook;
    await this.kv.put(this.key(to), JSON.stringify({ ...book, cycleStart: to }));
    await this.kv.delete(this.key(from));
    return 'moved';
  }
}

/** Dos fechas de inicio a esta distancia o menos son el mismo ciclo (UP: entre el verano y el ciclo I hay ~11 semanas). */
export const SAME_CYCLE_DAYS = 60;

/** Cursos que no entran al ponderado por defecto: EFE (Experiencias Formativas Estudiantiles, REC/NREC). */
export function defaultAcademic(name: string) {
  return !/^EFE\b/i.test(name.trim());
}

export function emptyCourse(name: string): CourseGrades {
  return { credits: null, academic: defaultAcademic(name), target: null, items: [] };
}

// ---------- validación ----------

const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));

export function validateCourse(body: Record<string, unknown>): CourseGrades {
  const credits = num(body.credits);
  if (credits !== null && (!Number.isFinite(credits) || credits < 0 || credits > 30)) {
    throw new ApiError('bad_request', 400, 'Créditos inválidos (0 a 30).');
  }
  const target = num(body.target);
  if (target !== null && (!Number.isInteger(target) || target < 0 || target > 20)) {
    throw new ApiError('bad_request', 400, 'La meta debe ser un entero de 0 a 20.');
  }
  if (!Array.isArray(body.items)) throw new ApiError('bad_request', 400, 'Faltan las evaluaciones.');
  if (body.items.length > MAX_ITEMS) throw new ApiError('bad_request', 400, `Máximo ${MAX_ITEMS} evaluaciones por curso.`);
  const items: GradeItem[] = body.items.map((raw, i) => {
    const it = (raw ?? {}) as Record<string, unknown>;
    const name = typeof it.name === 'string' ? it.name.trim().replace(/\s+/g, ' ') : '';
    if (!name || name.length > 60) throw new ApiError('bad_request', 400, `Evaluación ${i + 1}: el nombre debe tener entre 1 y 60 caracteres.`);
    const weight = Number(it.weight);
    if (!Number.isFinite(weight) || weight < 0 || weight > 100) throw new ApiError('bad_request', 400, `«${name}»: el peso debe estar entre 0 y 100 %.`);
    const grade = num(it.grade);
    if (grade !== null && (!Number.isFinite(grade) || grade < 0 || grade > 20)) throw new ApiError('bad_request', 400, `«${name}»: la nota debe estar entre 0 y 20.`);
    const id = typeof it.id === 'string' && /^[a-z0-9]{1,16}$/i.test(it.id) ? it.id : Math.random().toString(36).slice(2, 10);
    return { id, name, weight: round2(weight), grade: grade === null ? null : round2(grade) };
  });
  return { credits: credits === null ? null : round2(credits), academic: body.academic !== false, target, items };
}

export function validatePrior(body: Record<string, unknown>): GradeBook['prior'] {
  const average = num(body.average);
  const credits = num(body.credits);
  if (average !== null && (!Number.isFinite(average) || average < 0 || average > 20)) throw new ApiError('bad_request', 400, 'Acumulado inválido (0 a 20).');
  if (credits !== null && (!Number.isFinite(credits) || credits < 0 || credits > 400)) throw new ApiError('bad_request', 400, 'Créditos inválidos.');
  return { average: average === null ? null : round2(average), credits: credits === null ? null : round2(credits) };
}

// ---------- servicio ----------

export interface GradesResult {
  cycleStart: string;
  passing: number;
  courses: CourseSummary[];
  semester: SemesterSummary;
  prior: GradeBook['prior'];
}

export function buildResult(book: GradeBook, courseNames: string[]): GradesResult {
  const names = [...new Set([...courseNames, ...Object.keys(book.courses)])];
  const courses = names.map((n) => summarizeCourse(n, book.courses[n] ?? emptyCourse(n)));
  return { cycleStart: book.cycleStart, passing: PASSING, courses, semester: summarizeSemester(courses, book.prior), prior: book.prior };
}
