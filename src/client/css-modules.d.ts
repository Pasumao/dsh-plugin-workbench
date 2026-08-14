/**
 * Ambient declarations for CSS Modules. tsdown inlines these at build time;
 * this file only gives `tsc --noEmit` a stable shape to type against.
 */
declare module '*.module.css' {
  const classes: { readonly [key: string]: string }
  export default classes
}
