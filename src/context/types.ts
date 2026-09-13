export enum ContextCategory {
  REQUIREMENTS = 'REQUIREMENTS',
  ARCHITECTURE = 'ARCHITECTURE',
  API_CONTRACT = 'API_CONTRACT',
  DECISION = 'DECISION',
  CONVENTION = 'CONVENTION',
  DEPENDENCY = 'DEPENDENCY',
  AGENT_DISCOVERY = 'AGENT_DISCOVERY',
  FILE_LOCK = 'FILE_LOCK',
  SHARED_DECISION = 'SHARED_DECISION',
}

export interface ContextEntry {
  id: string;
  projectId: string;
  key: string;
  category: ContextCategory;
  title: string;
  content: string;
  version: number;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}
