/** The owner's dashboard page (./admin-page/): plain HTML + a script of the same origin, as the CSP allows. */
import { readFileSync } from 'node:fs';

const read = (name: string): string => readFileSync(new URL(`./admin-page/${name}`, import.meta.url), 'utf8');

export const ADMIN_PAGE_HTML = read('index.html');
export const ADMIN_PAGE_JS = read('admin.js');
