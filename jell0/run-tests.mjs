// Lets `node --test jell0/test/` (a bare folder) work on Node 22 and later,
// which run a folder argument as one module: test/package.json points here.
// Node 20 scans the folder itself and never loads this file.
// Plain form that works everywhere: node --test jell0/test/*.test.mjs
import { readdirSync } from 'node:fs'

const dir = new URL('./test/', import.meta.url)
for (const f of readdirSync(dir).filter(n => n.endsWith('.test.mjs')).sort()) await import(new URL(f, dir).href)
