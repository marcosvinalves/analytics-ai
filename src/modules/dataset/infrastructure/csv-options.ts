/** Shared T-007/T-008 CSV dialect. Header/inference are chosen explicitly by the caller. */
export const CSV_OPTIONS = `delim=',', quote='"', escape='"', comment='', skip=0,
  encoding='utf-8', compression='none', nullstr='', allow_quoted_nulls=true,
  ignore_errors=false, strict_mode=true, null_padding=false`;
