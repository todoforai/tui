/** Shared types for TUI */

export interface TuiState {
  projectId: string;
  projectName: string;
  agent: any;
  todoId: string;
  connected: boolean;
  watching: boolean;
}

export interface OutputLine {
  text: string;       // raw text (may contain ANSI)
  timestamp: number;
}
