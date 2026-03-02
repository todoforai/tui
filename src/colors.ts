/** Shared ANSI color constants — copied from CLI */

export const YELLOW = "\x1b[33m";
export const GREEN = "\x1b[32m";
export const RED = "\x1b[31m";
export const DIM = "\x1b[90m";
export const CYAN = "\x1b[36m";
export const BOLD = "\x1b[1m";
export const WHITE = "\x1b[38;2;255;255;255m";
export const BRIGHT_WHITE = "\x1b[97m";
export const BRAND = "\x1b[38;2;249;110;46m";
export const RESET = "\x1b[0m";

// Diff backgrounds
export const DIM_ATTR = "\x1b[2m";
export const BG_RED = "\x1b[48;2;55;20;20m";
export const BG_GREEN = "\x1b[48;2;20;45;20m";
export const BG_RED_HL = "\x1b[48;2;100;35;35m";
export const BG_GREEN_HL = "\x1b[48;2;35;85;35m";

// TUI-specific
export const INVERSE = "\x1b[7m";
export const BG_DARK = "\x1b[48;2;30;30;30m";
export const BG_STATUS = "\x1b[48;2;40;40;40m";
