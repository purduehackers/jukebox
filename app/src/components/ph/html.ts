import { cn } from './cn.ts';
import { pixelOrder } from './dither.ts';
import { icons, type IconName } from './icons.ts';

export type AttrValue = string | number | boolean | null | undefined;
export type HtmlAttrs = Record<string, AttrValue>;

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#x27;');
}

export function renderAttrs(attrs: HtmlAttrs): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (value === true) {
      parts.push(`${key}=""`);
    } else {
      parts.push(`${key}="${escapeHtml(String(value))}"`);
    }
  }
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

export interface IconOptions {
  name: IconName;
  label?: string;
  className?: string;
}

export function renderIcon({ name, label, className }: IconOptions): string {
  const attrs = renderAttrs({
    viewBox: '0 0 24 24',
    fill: 'currentColor',
    'shape-rendering': 'crispEdges',
    class: cn('size-4 shrink-0', className),
    role: label ? 'img' : undefined,
    'aria-label': label,
    'aria-hidden': label ? undefined : 'true',
    focusable: 'false',
  });
  return `<svg${attrs}>${icons[name]}</svg>`;
}

export type BadgeColor =
  | 'default'
  | 'yellow'
  | 'purple'
  | 'pink'
  | 'blue'
  | 'lime'
  | 'teal'
  | 'orange'
  | 'outline';

const badgeColors: Record<BadgeColor, string> = {
  default: 'bg-foreground text-background',
  yellow: 'bg-ph-yellow text-ph-black',
  purple: 'bg-ph-purple text-ph-cream',
  pink: 'bg-ph-pink text-ph-black',
  blue: 'bg-ph-blue text-ph-cream',
  lime: 'bg-ph-lime text-ph-black',
  teal: 'bg-ph-teal text-ph-black',
  orange: 'bg-ph-orange text-ph-black',
  outline: 'border border-foreground text-foreground',
};

export interface BadgeOptions {
  color?: BadgeColor;
  className?: string;
  children: string;
}

export function renderBadge({ color = 'default', className, children }: BadgeOptions): string {
  const cls = cn(
    'inline-flex w-fit items-center gap-1 px-1.5 py-0.5 font-mono text-[11px] leading-none font-semibold tracking-wide uppercase',
    badgeColors[color],
    className,
  );
  return `<span class="${escapeHtml(cls)}">${children}</span>`;
}

export type ButtonVariant = 'solid' | 'outline' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'lg';

const buttonVariants: Record<ButtonVariant, string> = {
  solid: 'bg-foreground text-background hover:bg-primary hover:text-primary-foreground',
  outline: 'border border-foreground text-foreground hover:bg-foreground hover:text-background',
  ghost: 'text-foreground hover:bg-foreground/[0.08]',
};

const buttonSizes: Record<ButtonSize, string> = {
  sm: 'h-8 gap-1.5 px-3 text-[13px]',
  md: 'h-10 gap-2 px-4 text-[15px]',
  lg: 'h-[52px] gap-2.5 px-6 text-xl',
};

export interface ButtonOptions {
  href?: string;
  type?: 'button' | 'submit' | 'reset';
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  iconEnd?: IconName;
  disabled?: boolean;
  className?: string;
  attrs?: HtmlAttrs;
  children: string;
}

export function renderButton({
  href,
  type = 'button',
  variant = 'solid',
  size = 'md',
  icon,
  iconEnd,
  disabled,
  className,
  attrs,
  children,
}: ButtonOptions): string {
  const tag = href ? 'a' : 'button';
  const cls = cn(
    'inline-flex w-fit shrink-0 cursor-pointer items-center justify-center font-mono font-semibold tracking-wide whitespace-nowrap uppercase no-underline transition-[color,background-color,transform] duration-150 ease-quint active:scale-[0.97] disabled:pointer-events-none disabled:opacity-40',
    buttonVariants[variant],
    buttonSizes[size],
    className,
  );
  const attrStr = renderAttrs({
    class: cls,
    href,
    type: href ? undefined : type,
    ...attrs,
    disabled: href ? undefined : disabled,
  });
  const startIcon = icon ? renderIcon({ name: icon }) : '';
  const endIcon = iconEnd ? renderIcon({ name: iconEnd }) : '';
  return `<${tag}${attrStr}>${startIcon}${children}${endIcon}</${tag}>`;
}

export interface DitherButtonOptions {
  href?: string;
  type?: 'button' | 'submit' | 'reset';
  tone?: 'light' | 'dark';
  cols?: number;
  rows?: number;
  disabled?: boolean;
  className?: string;
  style?: string;
  attrs?: HtmlAttrs;
  children: string;
}

export function renderDitherButton({
  href,
  type = 'button',
  tone,
  cols = 10,
  rows = 5,
  disabled,
  className,
  style,
  attrs,
  children,
}: DitherButtonOptions): string {
  const tag = href ? 'a' : 'button';
  const pixels = pixelOrder(cols * rows)
    .map((i) => `<span class="ph-dither-btn__pixel" style="--i: ${i}"></span>`)
    .join('');
  const mergedStyle = [`--cols: ${cols}`, style].filter(Boolean).join('; ');
  const attrStr = renderAttrs({
    class: cn('ph-dither-btn', className),
    'data-tone': tone,
    href,
    type: href ? undefined : type,
    style: mergedStyle,
    ...attrs,
    disabled: href ? undefined : disabled,
  });
  return `<${tag}${attrStr}><span class="ph-dither-btn__pixels" aria-hidden="true">${pixels}</span><span class="ph-dither-btn__label">${children}</span></${tag}>`;
}

export interface CardOptions {
  href?: string;
  title?: string;
  mediaHtml?: string;
  className?: string;
  attrs?: HtmlAttrs;
  children: string;
}

export function renderCard({ href, title, mediaHtml, className, attrs, children }: CardOptions): string {
  const tag = href ? 'a' : 'div';
  const external = href && /^https?:\/\//.test(href);
  const cls = cn(
    'flex flex-col gap-3 border border-border bg-card p-5 text-card-foreground no-underline',
    href && 'transition-colors duration-150 ease-quint hover:border-foreground',
    className,
  );
  const attrStr = renderAttrs({
    class: cls,
    href,
    target: external ? '_blank' : undefined,
    rel: external ? 'noopener noreferrer' : undefined,
    ...attrs,
  });
  const mediaPart = mediaHtml ? `<div class="-mx-5 -mt-5 border-b border-border">${mediaHtml}</div>` : '';
  const titlePart = title ? `<h3 class="ph-headline text-3xl">${escapeHtml(title)}</h3>` : '';
  return `<${tag}${attrStr}>${mediaPart}${titlePart}<div class="flex flex-col gap-2 leading-[1.45]">${children}</div></${tag}>`;
}

export interface FieldOptions {
  label: string;
  forId?: string;
  hint?: string;
  error?: string;
  className?: string;
  children: string;
}

export function renderField({ label, forId, hint, error, className, children }: FieldOptions): string {
  const labelAttr = forId ? ` for="${escapeHtml(forId)}"` : '';
  const footer = error
    ? `<p class="flex items-center gap-1.5 text-[13px]">${renderIcon({ name: 'exclamation-triangle', className: 'size-3.5 text-ph-orange' })}${escapeHtml(error)}</p>`
    : hint
      ? `<p class="text-[13px]">${escapeHtml(hint)}</p>`
      : '';
  return `<div class="${escapeHtml(cn('flex flex-col gap-1.5', className))}"><label${labelAttr} class="ph-subheadline text-[12px]">${escapeHtml(label)}</label>${children}${footer}</div>`;
}

export interface InputOptions {
  className?: string;
  attrs?: HtmlAttrs;
}

export function renderInput({ className, attrs }: InputOptions): string {
  const cls = cn(
    'h-10 w-full min-w-0 border border-input bg-card px-3 font-sans text-[15px] text-card-foreground outline-none transition-colors duration-150 ease-quint placeholder:text-card-foreground/55 focus-visible:border-foreground disabled:cursor-not-allowed disabled:opacity-40 aria-invalid:border-ph-orange',
    className,
  );
  return `<input${renderAttrs({ class: cls, ...attrs })} />`;
}
