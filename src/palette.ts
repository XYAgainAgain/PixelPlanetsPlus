const TAU = 6.28318;

function godotRound(value: number): number {
  return value >= 0 ? Math.floor(value + 0.5) : Math.ceil(value - 0.5);
}

function hexByte(value: number): string {
  const byte = Math.min(255, Math.max(0, godotRound(value * 255)));
  return byte.toString(16).padStart(2, "0");
}

export class Color {
  constructor(
    public r: number,
    public g: number,
    public b: number,
    public a = 1,
  ) {}

  static fromHex(hex: string): Color {
    const value = hex.startsWith("#") ? hex.slice(1) : hex;
    if (!/^[0-9a-fA-F]{6}$/.test(value)) {
      throw new TypeError(`Invalid RGB hex color: ${hex}`);
    }

    return new Color(
      Number.parseInt(value.slice(0, 2), 16) / 255,
      Number.parseInt(value.slice(2, 4), 16) / 255,
      Number.parseInt(value.slice(4, 6), 16) / 255,
    );
  }

  darkened(amount: number): Color {
    return new Color(
      this.r * (1 - amount),
      this.g * (1 - amount),
      this.b * (1 - amount),
      this.a,
    );
  }

  lightened(amount: number): Color {
    return new Color(
      this.r + (1 - this.r) * amount,
      this.g + (1 - this.g) * amount,
      this.b + (1 - this.b) * amount,
      this.a,
    );
  }

  get h(): number {
    const minimum = Math.min(this.r, this.g, this.b);
    const maximum = Math.max(this.r, this.g, this.b);
    const delta = maximum - minimum;
    if (delta === 0) return 0;

    let hue: number;
    if (this.r === maximum) {
      hue = (this.g - this.b) / delta;
    } else if (this.g === maximum) {
      hue = 2 + (this.b - this.r) / delta;
    } else {
      hue = 4 + (this.r - this.g) / delta;
    }

    hue /= 6;
    return hue < 0 ? hue + 1 : hue;
  }

  set h(hue: number) {
    const maximum = Math.max(this.r, this.g, this.b);
    const minimum = Math.min(this.r, this.g, this.b);
    const saturation = maximum !== 0 ? (maximum - minimum) / maximum : 0;
    this.setHsv(hue, saturation, maximum);
  }

  toHtml(): string {
    return hexByte(this.r) + hexByte(this.g) + hexByte(this.b);
  }

  toHex(): string {
    return `#${this.toHtml()}`;
  }

  private setHsv(hue: number, saturation: number, value: number): void {
    if (saturation === 0) {
      this.r = value;
      this.g = value;
      this.b = value;
      return;
    }

    const scaledHue = (hue * 6) % 6;
    const sector = Math.floor(scaledHue);
    const fraction = scaledHue - sector;
    const p = value * (1 - saturation);
    const q = value * (1 - saturation * fraction);
    const t = value * (1 - saturation * (1 - fraction));

    switch (sector) {
      case 0: [this.r, this.g, this.b] = [value, t, p]; break;
      case 1: [this.r, this.g, this.b] = [q, value, p]; break;
      case 2: [this.r, this.g, this.b] = [p, value, t]; break;
      case 3: [this.r, this.g, this.b] = [p, q, value]; break;
      case 4: [this.r, this.g, this.b] = [t, p, value]; break;
      default: [this.r, this.g, this.b] = [value, p, q]; break;
    }
  }
}

export function generateColorscheme(
  nColors: number,
  hueDiff: number,
  saturation: number,
  rng: () => number,
): Color[] {
  const a = [0.5, 0.5, 0.5] as const;
  const b = [0.5 * saturation, 0.5 * saturation, 0.5 * saturation] as const;
  const c = [
    (0.5 + rng()) * hueDiff,
    (0.5 + rng()) * hueDiff,
    (0.5 + rng()) * hueDiff,
  ] as const;
  const dMultiplierInputs = [rng(), rng(), rng()] as const;
  const dMultiplier = 1 + rng() * 2;
  const d = [
    dMultiplierInputs[0] * dMultiplier,
    dMultiplierInputs[1] * dMultiplier,
    dMultiplierInputs[2] * dMultiplier,
  ] as const;

  const colors: Color[] = [];
  const n = Math.max(1, nColors - 1);
  for (let i = 0; i < nColors; i += 1) {
    const position = i / n;
    colors.push(new Color(
      a[0] + b[0] * Math.cos(TAU * (c[0] * position + d[0])),
      a[1] + b[1] * Math.cos(TAU * (c[1] * position + d[1])),
      a[2] + b[2] * Math.cos(TAU * (c[2] * position + d[2])),
    ));
  }

  return colors;
}
