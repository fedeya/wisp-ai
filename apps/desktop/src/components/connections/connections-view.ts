import type { Model, Status } from '../../api';

export type ConnectionsView = {
  status: Pick<Status, 'auth' | 'connections' | 'search' | 'model'> | null;
  models: Model[];
  account: string;
  model: string;
  busy: string;
  busyTarget: string;
  locked: boolean;
  modelsError: string;
  chooseAccount: (account: string) => void;
  chooseModel: (model: string) => void;
  showOverview: () => void;
  signIn: (add?: boolean) => Promise<void>;
  loadModels: () => Promise<void>;
  refresh: () => Promise<void>;
  confirm: (action: { label: string; run: () => Promise<void> }) => void;
  work: (
    label: string,
    action: () => Promise<unknown>,
    success?: string,
    target?: string,
  ) => Promise<void>;
};
