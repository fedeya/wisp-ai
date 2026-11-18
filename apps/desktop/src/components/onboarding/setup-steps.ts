/** Screens of the first-run wizard, in order. */
export const wizardScreens = ['welcome', 'addon', 'provider', 'ready'] as const;
export type WizardScreen = (typeof wizardScreens)[number];

export type RailStepState = 'done' | 'current' | 'upcoming';
/** `complete` marks Ready once setup is done, so the last step shows a check. */
export type RailStep = {
  screen: WizardScreen;
  title: string;
  state: RailStepState;
  complete: boolean;
};

const titles: Record<WizardScreen, string> = {
  welcome: 'Welcome',
  addon: 'Install addon',
  provider: 'Connect AI',
  ready: 'Ready',
};

/** Only the addon and AI provider are setup steps; welcome and ready frame them. */
export const countedSteps: readonly WizardScreen[] = ['addon', 'provider'];

/** Where a (re)opened wizard starts: an installed addon skips welcome and the addon step. */
export function firstScreen(configured: boolean): WizardScreen {
  return configured ? 'provider' : 'welcome';
}

/** The side rail: everything before the current screen is done. */
export function railSteps(screen: WizardScreen): RailStep[] {
  const current = wizardScreens.indexOf(screen);
  return wizardScreens.map((item, index) => ({
    screen: item,
    title: titles[item],
    state: index < current ? 'done' : index === current ? 'current' : 'upcoming',
    complete: index <= current && screen === 'ready',
  }));
}

/** "Step 1 of 2" for the counted steps, nothing for welcome and ready. */
export function stepLabel(screen: WizardScreen): string | undefined {
  const index = countedSteps.indexOf(screen);
  return index === -1 ? undefined : `Step ${index + 1} of ${countedSteps.length}`;
}
