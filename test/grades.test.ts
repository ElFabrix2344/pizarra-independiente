import { describe, expect, it } from 'vitest';
import {
  buildResult,
  emptyCourse,
  GradeStore,
  need,
  roundHalfUp,
  summarizeCourse,
  summarizeSemester,
  trunc2,
  validateCourse,
  validatePrior,
  type CourseGrades,
  type GradeBook,
} from '../src/services/grades';

const course = (items: Array<[string, number, number | null]>, extra: Partial<CourseGrades> = {}): CourseGrades => ({
  credits: 4,
  academic: true,
  target: null,
  items: items.map(([name, weight, grade], i) => ({ id: 'i' + i, name, weight, grade })),
  ...extra,
});

describe('redondeo según el reglamento', () => {
  it('la CA sube desde .5; los ponderados truncan a 2 decimales', () => {
    expect(roundHalfUp(10.5)).toBe(11);
    expect(roundHalfUp(10.49)).toBe(10);
    expect(roundHalfUp(14.5)).toBe(15);
    expect(roundHalfUp(0.15 * 12 + 0.85 * 11)).toBe(11); // 11.15
    expect(trunc2(14.729)).toBe(14.72);
    expect(trunc2(15)).toBe(15);
    expect(trunc2(13.3333)).toBe(13.33);
  });
});

describe('resumen de un curso', () => {
  it('a mitad del ciclo: promedio de lo evaluado, rango y cuánto necesito', () => {
    // PC1 15% (14), PC2 15% (12), Parcial 30% (—), Final 40% (—)
    const s = summarizeCourse('EPP', course([['PC1', 15, 14], ['PC2', 15, 12], ['Parcial', 30, null], ['Final', 40, null]]));
    expect(s.gradedWeight).toBe(30);
    expect(s.remainingWeight).toBe(70);
    expect(s.earned).toBe(3.9); // 0.15·14 + 0.15·12
    expect(s.average).toBe(13);
    expect(s.projected).toBe(13);
    expect(s.final).toBeNull();
    expect(s.min).toBe(3.9);
    expect(s.max).toBe(17.9);
    // para aprobar: (10.5 − 3.9) / 0.70 = 9.43 → 9.5 (redondeado hacia arriba a 1 decimal)
    expect(s.pass).toEqual({ target: 11, status: 'possible', average: 9.5 });
    expect(s.weightWarning).toBeNull();
  });
  it('meta: (14.5 − 3.9) / 0.70 = 15.14 → 15.2', () => {
    const s = summarizeCourse('EPP', course([['PC1', 15, 14], ['PC2', 15, 12], ['Parcial', 30, null], ['Final', 40, null]], { target: 15 }));
    expect(s.goal).toEqual({ target: 15, status: 'possible', average: 15.2 });
  });
  it('aprobado asegurado, imposible y final', () => {
    const seg = summarizeCourse('A', course([['T', 60, 18], ['F', 40, null]]));
    expect(seg.pass.status).toBe('secured'); // 10.8 ≥ 10.5
    const imp = summarizeCourse('B', course([['T', 80, 5], ['F', 20, null]]));
    expect(imp.pass.status).toBe('impossible'); // 4 + 0.2·20 = 8 < 10.5
    const fin = summarizeCourse('C', course([['T', 50, 11], ['F', 50, 10]]));
    expect(fin.final).toBe(11); // 10.5 → 11
    expect(fin.pass.status).toBe('done');
    const fail = summarizeCourse('D', course([['T', 50, 10], ['F', 50, 10]]));
    expect(fail.final).toBe(10);
    expect(fail.pass.status).toBe('impossible');
  });
  it('avisa si los pesos no suman 100 %', () => {
    expect(summarizeCourse('A', course([['T', 60, null], ['F', 30, null]])).weightWarning).toMatch(/falta 10 %/);
    expect(summarizeCourse('A', course([['T', 60, null], ['F', 50, null]])).weightWarning).toMatch(/sobra 10 %/);
    expect(summarizeCourse('A', emptyCourse('A')).weightWarning).toBeNull();
  });
  it('need() en los bordes', () => {
    expect(need(11, 10.5, 0, true).status).toBe('done');
    expect(need(11, 10.49, 0, true).status).toBe('impossible');
    expect(need(11, 0, 100, false)).toEqual({ target: 11, status: 'possible', average: 10.5 });
  });
});

describe('ponderado del semestre y acumulado', () => {
  it('Σ(CA × créditos) / Σ créditos, truncado; fuera los no académicos y los incompletos', () => {
    const cs = [
      summarizeCourse('A', course([['T', 100, 15]], { credits: 4 })), // CA 15
      summarizeCourse('B', course([['T', 50, 12], ['F', 50, null]], { credits: 3 })), // proyectada 12
      summarizeCourse('EFE', course([['T', 100, 20]], { credits: 1, academic: false })),
      summarizeCourse('C', course([['T', 100, null]], { credits: 4 })), // sin notas
      summarizeCourse('D', course([['T', 100, 14]], { credits: null })), // sin créditos
    ];
    const sem = summarizeSemester(cs, { average: null, credits: null });
    expect(sem.semester).toBe(13.71); // (60 + 36) / 7 = 13.714…
    expect(sem.credits).toBe(7);
    expect(sem.missing).toEqual([{ name: 'C', reason: 'grades' }, { name: 'D', reason: 'credits' }]);
    expect(sem.cumulative).toBeNull();
    const withPrior = summarizeSemester(cs, { average: 14.72, credits: 94 });
    expect(withPrior.cumulative).toBe(14.65); // (14.72·94 + 96) / 101 = 14.6502… → truncado 14.65
  });
});

describe('validación y armado', () => {
  it('rechaza datos fuera de rango', () => {
    expect(() => validateCourse({ items: [{ name: 'PC1', weight: 120 }] })).toThrow();
    expect(() => validateCourse({ items: [{ name: 'PC1', weight: 20, grade: 21 }] })).toThrow();
    expect(() => validateCourse({ items: [{ name: '', weight: 20 }] })).toThrow();
    expect(() => validateCourse({ target: 15.5, items: [] })).toThrow();
    expect(() => validatePrior({ average: 25 })).toThrow();
  });
  it('normaliza y conserva ids', () => {
    const c = validateCourse({ credits: '4', academic: true, target: '15', items: [{ id: 'abc', name: '  PC1  ', weight: '15', grade: '' }] });
    expect(c).toEqual({ credits: 4, academic: true, target: 15, items: [{ id: 'abc', name: 'PC1', weight: 15, grade: null }] });
  });
  it('buildResult incluye cursos visibles y los que ya tienen datos; EFE no académico por defecto', () => {
    const r = buildResult({ cycleStart: '2026-08-10', courses: { Viejo: course([['T', 100, 12]]) }, prior: { average: null, credits: null } }, ['HEE', 'EFE Presentaciones']);
    expect(r.courses.map((c) => c.name)).toEqual(['HEE', 'EFE Presentaciones', 'Viejo']);
    expect(r.courses.find((c) => c.name === 'EFE Presentaciones')!.academic).toBe(false);
    expect(r.passing).toBe(11);
  });
});

describe('libro de notas al cambiar el inicio del ciclo', () => {
  const kv = () => {
    const m = new Map<string, string>();
    const k = {
      get: async (key: string, type?: string) => (m.has(key) ? (type === 'json' ? JSON.parse(m.get(key)!) : m.get(key)!) : null),
      put: async (key: string, v: string) => void m.set(key, v),
      delete: async (key: string) => void m.delete(key),
    } as unknown as KVNamespace;
    return { m, k };
  };
  const book = (cycleStart: string): GradeBook => ({ cycleStart, courses: { HEE: course([['PC1', 50, 15]]) }, prior: { average: 14.2, credits: 90 } });

  it('un ajuste de pocas semanas mueve las notas a la nueva fecha (y volver atrás también)', async () => {
    const { m, k } = kv();
    const store = new GradeStore(k);
    await store.put(book('2026-08-10'));
    expect(await store.followCycle('2026-08-10', '2026-08-17')).toBe('moved');
    expect(m.has('grades:2026-08-10')).toBe(false);
    const moved = await store.get('2026-08-17');
    expect(moved.courses.HEE!.items[0]!.grade).toBe(15);
    expect(moved.prior).toEqual({ average: 14.2, credits: 90 });
    // Lo editado tras el ajuste vuelve con la fecha anterior (no queda una copia vieja esperando).
    await store.put({ ...moved, prior: { average: 15, credits: 90 } });
    expect(await store.followCycle('2026-08-17', '2026-08-10')).toBe('moved');
    expect((await store.get('2026-08-10')).prior.average).toBe(15);
  });
  it('otro ciclo empieza vacío y el anterior queda guardado', async () => {
    const { m, k } = kv();
    const store = new GradeStore(k);
    await store.put(book('2026-08-10'));
    expect(await store.followCycle('2026-08-10', '2027-03-22')).toBe('new');
    expect(m.has('grades:2026-08-10')).toBe(true);
    expect((await store.get('2027-03-22')).courses).toEqual({});
  });
  it('no toca nada si la fecha no cambia, si no hay notas o si la nueva fecha ya tiene las suyas', async () => {
    const { m, k } = kv();
    const store = new GradeStore(k);
    expect(await store.followCycle('2026-08-10', '2026-08-17')).toBe('none');
    await store.put(book('2026-08-10'));
    expect(await store.followCycle('2026-08-10', '2026-08-10')).toBe('none');
    await store.put({ ...book('2026-08-17'), prior: { average: 16, credits: 90 } });
    expect(await store.followCycle('2026-08-10', '2026-08-17')).toBe('none');
    expect(m.has('grades:2026-08-10')).toBe(true);
    expect((await store.get('2026-08-17')).prior.average).toBe(16);
  });
});
