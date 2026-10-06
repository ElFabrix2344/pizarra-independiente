// Tipos de la TickTick Open API v1, según https://developer.ticktick.com/docs/openapi.md
// (sección "Definitions"). Los campos son opcionales salvo `id`: la API omite
// los que no tienen valor.

/** Prioridad: None 0, Low 1, Medium 3, High 5. */
export type TickTickPriority = 0 | 1 | 3 | 5;

/** Estado: Abandoned -1, Normal 0, Completed 2. */
export type TickTickStatus = -1 | 0 | 2;

export interface TickTickChecklistItem {
  id: string;
  title?: string;
  status?: 0 | 1;
  completedTime?: string;
  isAllDay?: boolean;
  sortOrder?: number;
  startDate?: string;
  timeZone?: string;
}

export interface TickTickTask {
  id: string;
  projectId: string;
  title?: string;
  content?: string;
  desc?: string;
  isAllDay?: boolean;
  /** "yyyy-MM-dd'T'HH:mm:ssZ", p. ej. "2019-11-13T03:00:00+0000" */
  startDate?: string;
  dueDate?: string;
  completedTime?: string;
  timeZone?: string;
  reminders?: string[];
  repeatFlag?: string;
  repeatFrom?: '0' | '1' | '2';
  priority?: TickTickPriority;
  status?: TickTickStatus;
  sortOrder?: number;
  items?: TickTickChecklistItem[];
  tags?: string[];
  kind?: 'TEXT' | 'NOTE' | 'CHECKLIST';
  parentId?: string;
  assigneeUsername?: string;
  etag?: string;
  /** No figura en la definición oficial de Task; algunas respuestas lo incluyen en proyectos kanban. */
  columnId?: string;
}

export interface TickTickProject {
  id: string;
  name: string;
  color?: string;
  sortOrder?: number;
  closed?: boolean;
  groupId?: string;
  viewMode?: 'list' | 'kanban' | 'timeline';
  permission?: 'read' | 'write' | 'comment';
  kind?: 'TASK' | 'NOTE';
}

export interface TickTickColumn {
  id: string;
  projectId: string;
  name: string;
  sortOrder?: number;
}

/** GET /open/v1/project/{projectId}/data — `tasks` son solo las no completadas. */
export interface TickTickProjectData {
  project: TickTickProject;
  tasks: TickTickTask[];
  columns?: TickTickColumn[];
}

export interface TickTickTokenResponse {
  access_token: string;
  token_type?: string;
  /** Segundos. La doc no lo garantiza, pero el servidor OAuth suele enviarlo. */
  expires_in?: number;
  scope?: string;
  refresh_token?: string;
}

/** Scopes disponibles según la doc. */
export type TickTickScope = 'tasks:read' | 'tasks:write';
