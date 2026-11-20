import { migrateDesktop } from '../src/migrations/desktop.ts';
if (!process.argv[2] || !process.env.WISP_DATA_DIR) {
  throw Error('A previous installation folder and WISP_DATA_DIR are required.');
}
await migrateDesktop(process.argv[2], process.env.WISP_DATA_DIR);
console.log('Imported Wisp chats, memory, configuration and protected credentials.');
