# Contributor skills

Load the skill that matches the area you are changing, along with the references relevant to the task. These skills run in the coding assistant's context. Desktop components, bridge tools, and installer resources are built separately.

`.claude/skills` is a symlink to this directory, so Claude Code discovers the same skills. On Windows, enable Developer Mode and run `git config core.symlinks true` before checkout; otherwise the link becomes a plain text file.

| Skill                                                               | Use in Wisp                                                                                | Source                                                                                                                               |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| [Base UI](base-ui/SKILL.md)                                         | Dialog composition, focus, field errors and keyboard behavior                              | [noklip-io](https://github.com/noklip-io/agent-skills/tree/319a0f1aac3b3580e736d457f217d716b356aa35/skills/base-ui)                  |
| [React Router](react-router/SKILL.md)                               | Desktop route definitions, navigation and router lifetime in Data Mode                     | [Remix](https://github.com/remix-run/react-router/tree/5d7962ea44fefef43718a6f9e6cce17f4e7e04ab/.agents/skills/react-router)         |
| [React Testing](react-testing/SKILL.md)                             | User-observable component and form regressions in Testing Library                          | [ECC](https://github.com/affaan-m/ecc/tree/d2ef2680594f9a17526a6e1a2e18b3d242c5d17b/skills/react-testing)                            |
| [Tauri events](tauri-calling-frontend/SKILL.md)                     | Bridge listener cleanup, progress updates and native IPC tests                             | Wisp guide based on [Tauri's documentation](https://v2.tauri.app/develop/calling-frontend/)                                          |
| [Vercel Composition Patterns](vercel-composition-patterns/SKILL.md) | Screen and component boundaries                                                            | [Vercel Labs](https://github.com/vercel-labs/agent-skills/tree/1a2c79d4e6c4a2283dc2c614b6538cbe1ed5ca62/skills/composition-patterns) |
| [Vercel React Best Practices](vercel-react-best-practices/SKILL.md) | Client rendering and subscriptions in desktop, plus React and Next.js guidance for the web | [Vercel Labs](https://github.com/vercel-labs/agent-skills/tree/1a2c79d4e6c4a2283dc2c614b6538cbe1ed5ca62/skills/react-best-practices) |
| [Vite](vite/SKILL.md)                                               | Desktop and updater HTML entry points, bundling and the local preview                      | [Anthony Fu](https://github.com/antfu/skills/tree/d524ed287eef22757297827ce42e3cad88abd20c/skills/vite)                              |
| [Vitest](vitest/SKILL.md)                                           | Deterministic async tests, mocks and cleanup                                               | [Anthony Fu](https://github.com/antfu/skills/tree/d524ed287eef22757297827ce42e3cad88abd20c/skills/vitest)                            |
| [Zustand](zustand/SKILL.md)                                         | The desktop's vanilla store, selectors and test isolation                                  | [oakoss](https://github.com/oakoss/agent-skills/tree/85e3a3919d9e0ec7f7302a5143ec4b3e66f5f6ad/skills/zustand)                        |
| [Visual PR](visual-pr/SKILL.md)                                     | Preparing a pull request description                                                       | Wisp adaptation of [HumanLayer](https://github.com/humanlayer/humanlayer)                                                            |

For TanStack Form, use the official [validation](https://tanstack.com/form/latest/docs/framework/react/guides/validation) and [async initial values](https://tanstack.com/form/latest/docs/framework/react/guides/async-initial-values) guides with the version pinned by the workspace.

Imported skills keep their upstream formatting. References outside the copied trees link to the pinned source.

When updating an imported skill, update its source revision, preserve the upstream attribution and include the supporting files used by the new version.
