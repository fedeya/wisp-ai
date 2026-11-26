import { Impit, type ImpitOptions } from 'impit';

export function impitClient(options: ImpitOptions) {
  return new Impit(options);
}
