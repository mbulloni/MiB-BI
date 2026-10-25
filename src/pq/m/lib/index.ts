// The M standard library: every module registers its functions and constants in one map (name → value).
import type { Lib } from './core';
import { register as text } from './text';
import { register as datetime } from './datetime';
import { register as list } from './list';
import { register as table } from './table';
import { register as misc } from './misc';
import { register as sources } from './sources';
import { register as fuzzy } from './fuzzy';

let LIB: Lib | null = null;
export function library(): Lib {
  if (LIB) return LIB;
  LIB = new Map();
  for (const r of [misc, text, datetime, list, table, sources, fuzzy]) r(LIB);
  return LIB;
}
