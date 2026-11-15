import { characterLabel } from '@wisp/protocol/character-key';
import { describeRoutineTrigger } from '@wisp/protocol/routines';
import { request } from '../api';
import { ActionProgress } from '../components/ui/ActionProgress';
import DataState from '../components/ui/DataState';
import { Button, Card } from '../components/ui/Controls';
import { useDesktop } from '../use-desktop';

export default function Routines() {
  const app = useDesktop((state) => ({
    loading: state.loading,
    status: state.status,
    busyTarget: state.busyTarget,
    busy: state.busy,
    work: state.actions.work,
    setConfirmation: state.actions.setConfirmation,
  }));
  if (app.loading || !app.status) return <DataState />;
  const { routines, routineRuns, gameConnected } = app.status;

  return (
    <>
      <Card density="compact">
        <h2>{routines.length ? 'Create another routine in game' : 'No routines yet'}</h2>
        <p className="text-muted text-[13px]">
          Try “Every two levels, review my spells and rotation” or “When I change weapons, review my
          equipment.” Routines run while the character is connected, outside combat. Each run has
          its own conversation.
        </p>
      </Card>
      {routines.map((routine) => {
        const { characterKey, id } = routine;
        const target = characterKey + id;
        const runs = routineRuns
          .filter((run) => run.routineId === id && run.characterKey === characterKey)
          .reverse();
        return (
          <Card key={target} density="compact">
            <div className="section-title gap-[18px] flex items-center justify-between [&_>_svg]:text-muted">
              <div>
                <h2>{routine.title}</h2>
                <p className="text-muted text-[13px]">
                  {routine.enabled ? 'Active' : 'Paused'} · {characterLabel(characterKey)}
                </p>
              </div>
              <div className="actions gap-[10px] mt-0 flex flex-wrap items-center">
                <ActionProgress label={app.busyTarget === target ? app.busy : ''} />
                <Button
                  disabled={!!app.busy}
                  onClick={() =>
                    app.work(
                      'Updating routine',
                      () =>
                        request('/routines/action', {
                          characterKey,
                          id,
                          operation: routine.enabled ? 'pause' : 'resume',
                        }),
                      'Routine updated.',
                      target,
                    )
                  }
                >
                  {routine.enabled ? 'Pause' : 'Resume'}
                </Button>
                <Button
                  intent="quiet"
                  destructive
                  disabled={!!app.busy}
                  onClick={() =>
                    app.setConfirmation({
                      label: `Delete “${routine.title}”?`,
                      run: () =>
                        app.work(
                          'Deleting routine',
                          () =>
                            request('/routines/action', { characterKey, id, operation: 'remove' }),
                          'Routine deleted.',
                          target,
                        ),
                    })
                  }
                >
                  Delete
                </Button>
              </div>
            </div>
            <p className="text-muted text-[13px]">{routine.instruction}</p>
            <p className="muted text-muted text-[13px]">
              {routine.triggers.map(describeRoutineTrigger).join(' or ')}
            </p>
            <details className="routine-history border-t-[1px] [border-top-style:solid] border-t-[var(--border)] mt-3 pt-3">
              <summary className="cursor-pointer text-muted text-[13px]">
                Run history ({runs.length})
              </summary>
              {runs.map((run) => (
                <div
                  key={run.id}
                  className="section-title gap-[18px] px-0 py-[12px] flex items-center justify-between border-b-[1px] [border-bottom-style:solid] border-b-[var(--border)] [&_>_svg]:text-muted"
                >
                  <div>
                    <p className="text-muted text-[13px]">
                      {new Date(run.startedAt).toLocaleString()} ·{' '}
                      {run.status === 'no_tip' ? 'No updates' : run.status}
                    </p>
                    {(run.status === 'error' || run.status === 'interrupted') && (
                      <p className="muted text-muted text-[13px]">{run.summary}</p>
                    )}
                  </div>
                  {run.status !== 'no_tip' && (
                    <Button
                      disabled={!!app.busy || !gameConnected}
                      onClick={() =>
                        app.work(
                          'Opening run',
                          () => request('/routines/open', { id: run.id }),
                          'Conversation selected in WoW. Open /wisp to continue.',
                          target,
                        )
                      }
                    >
                      Open in game
                    </Button>
                  )}
                </div>
              ))}
              {!runs.length && <p className="muted text-muted text-[13px]">No runs yet.</p>}
            </details>
          </Card>
        );
      })}
    </>
  );
}
