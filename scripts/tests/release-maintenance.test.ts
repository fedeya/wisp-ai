import { expect, test, vi } from 'vitest';
import { installerBuildVersion } from '../installer-version.ts';
import { syncReleaseNotes, type NotesStore } from '../sync-release-notes.ts';
import { updateManifest } from '../update-manifest.ts';

test.each(['0.0.7', '0.0.8-nightly.123.2'])(
  'installer verification uses the artifact version %s independently of the source checkout',
  (version) => {
    const manifest = updateManifest(
      version,
      'signature',
      'Old notes',
      version.includes('-') ? 'nightly' : 'stable',
    );
    expect(installerBuildVersion(`WispAI-${version}-windows-x64-setup.exe`, manifest)).toBe(
      version,
    );
    expect(() => installerBuildVersion('WispAI-0.0.6-windows-x64-setup.exe', manifest)).toThrow(
      'same signed build',
    );
    manifest.platforms['windows-x86_64'].url = 'https://example.com/wrong.exe';
    expect(() =>
      installerBuildVersion(`WispAI-${version}-windows-x64-setup.exe`, manifest),
    ).toThrow();
  },
);

const notes = '# Wisp updates\n\n## Fixed\n\n- Fixed connections.\n';
function fixture(version = '0.0.7', feedVersion = version) {
  const tag = `v${version}`;
  const release = { body: 'Original body', isDraft: false, isPrerelease: version.includes('-') };
  const manifests = new Map<string, Parameters<NotesStore['writeManifest']>[1]>([
    [
      tag,
      {
        ...updateManifest(
          version,
          'original-signature',
          'Original notes',
          release.isPrerelease ? 'nightly' : 'stable',
        ),
        custom: { preserve: true },
      },
    ],
    [
      'nightly',
      updateManifest(
        feedVersion,
        'feed-signature',
        'Feed notes',
        feedVersion.includes('-') ? 'nightly' : 'stable',
      ),
    ],
  ]);
  const original = structuredClone(manifests);
  const store: NotesStore = {
    release: vi.fn(() => ({ ...release })),
    manifest: vi.fn((target) => structuredClone(manifests.get(target)!)),
    writeBody: vi.fn(async (_target, body) => {
      release.body = body;
    }),
    writeManifest: vi.fn(async (target, manifest) => {
      manifests.set(target, structuredClone(manifest));
    }),
  };
  return { tag, release, manifests, original, store };
}

test('notes preview performs no writes; applying changes only notes and preserves all manifest fields', async () => {
  const f = fixture();
  expect((await syncReleaseNotes(f.tag, notes, f.store)).applied).toBe(false);
  expect(f.store.writeBody).not.toHaveBeenCalled();
  expect(f.store.writeManifest).not.toHaveBeenCalled();
  await syncReleaseNotes(f.tag, notes, f.store, true);
  expect(f.release.body).toBe(notes);
  expect(f.manifests.get(f.tag)).toEqual({ ...f.original.get(f.tag), notes });
  expect(f.manifests.get('nightly')).toEqual(f.original.get('nightly'));
});

test.each([true, false])(
  'nightly notes update the moving feed only if it targets this build: %s',
  async (current) => {
    const f = fixture(
      '0.0.8-nightly.123.2',
      current ? '0.0.8-nightly.123.2' : '0.0.8-nightly.124.1',
    );
    await syncReleaseNotes(f.tag, notes, f.store, true);
    expect(f.manifests.get('nightly')).toEqual(
      current ? { ...f.original.get('nightly'), notes } : f.original.get('nightly'),
    );
  },
);

test('failed writes restore original release and both nightly manifests', async () => {
  const f = fixture('0.0.8-nightly.123.2');
  vi.mocked(f.store.writeBody).mockImplementationOnce(async (_tag, body) => {
    f.release.body = body;
    throw Error('Connection lost after write');
  });
  await expect(syncReleaseNotes(f.tag, notes, f.store, true)).rejects.toThrow(
    'previous notes were restored',
  );
  expect(f.release.body).toBe('Original body');
  expect(f.manifests).toEqual(f.original);
});

test('mismatched release manifests and invalid notes fail before any writes', async () => {
  const f = fixture();
  f.manifests.get(f.tag)!.version = '0.0.6';
  await expect(syncReleaseNotes(f.tag, notes, f.store, true)).rejects.toThrow('does not match');
  await expect(syncReleaseNotes(f.tag, '# unfinished', f.store, true)).rejects.toThrow(
    'user-facing',
  );
  expect(f.store.writeManifest).not.toHaveBeenCalled();
  expect(f.store.writeBody).not.toHaveBeenCalled();
});

test('a failed read-back also restores notes, and incomplete rollback is reported', async () => {
  const f = fixture();
  vi.mocked(f.store.release)
    .mockReturnValueOnce({ ...f.release })
    .mockReturnValueOnce({
      ...f.release,
      body: 'Unexpected server response',
    });
  await expect(syncReleaseNotes(f.tag, notes, f.store, true)).rejects.toThrow(
    'previous notes were restored',
  );
  expect(f.manifests).toEqual(f.original);
  expect(f.release.body).toBe('Original body');

  vi.mocked(f.store.writeManifest).mockRejectedValue(Error('Server unavailable'));
  await expect(syncReleaseNotes(f.tag, notes, f.store, true)).rejects.toThrow(
    'rollback was incomplete',
  );
});
