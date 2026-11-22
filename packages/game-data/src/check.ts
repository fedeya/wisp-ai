// Says whether a newer Forever build than the pinned one is out, so the game
// data can be regenerated after a patch. Exits 1 when the pin is behind.
//   pnpm data:check
import { latestBuild, pinned } from './index.ts';

const parts = (version: string) => version.split('.').map(Number);
function newer(a: string, b: string): boolean {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) {
      return (x[i] ?? 0) > (y[i] ?? 0);
    }
  }
  return false;
}

const latest = await latestBuild(pinned.product);
if (newer(latest.version, pinned.build)) {
  console.log(
    `Forever ${latest.version} (${latest.created}) is newer than the pinned ${pinned.build}: ` +
      'set it in packages/game-data/build.json and run pnpm data:generate.',
  );
  process.exitCode = 1;
} else {
  console.log(`Game data is generated from the latest Forever build, ${pinned.build}.`);
}
