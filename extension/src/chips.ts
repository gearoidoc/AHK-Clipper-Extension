// The option chips, shared by the capture dialog and the hotstring editor.
// Each chip is a real checkbox, so Tab and Space work.
import { OPTION_INFO, type HotstringOptions } from './hotstring.ts';

export interface OptionChips {
  read(): HotstringOptions;
  set(options: HotstringOptions): void;
}

export function createOptionChips(container: HTMLElement, onChange: () => void): OptionChips {
  const inputs = new Map<keyof HotstringOptions, HTMLInputElement>();
  for (const { key, letter, label, help } of OPTION_INFO) {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.name = key;
    input.addEventListener('change', onChange);
    const code = document.createElement('code');
    code.textContent = letter;
    const chip = document.createElement('label');
    chip.className = 'chip';
    chip.title = help;
    chip.append(input, code, ` ${label}`);
    container.append(chip);
    inputs.set(key, input);
  }
  return {
    read() {
      const options = {} as HotstringOptions;
      for (const [key, input] of inputs) options[key] = input.checked;
      return options;
    },
    set(options) {
      for (const [key, input] of inputs) input.checked = options[key];
    },
  };
}
