export enum ContextCategory {
  REQUIREMENTS = 'REQUIREMENTS',
  ARCHITECTURE = 'ARCHITECTURE',
  API_CONTRACT = 'API_CONTRACT',
  DECISION = 'DECISION',
  CONVENTION = 'CONVENTION',
  DEPENDENCY = 'DEPENDENCY',
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
