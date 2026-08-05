import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'

// data-pg-only tags are the static Tailwind build Pinegrow's offline preview needs; strip them so Vite never serves/ships them
const stripPgOnly = () => ({
  name: 'strip-pg-only',
  // order 'pre' runs before Vite's asset scan, or the stripped stylesheet still gets bundled
  transformIndexHtml: {
    order: 'pre',
    handler: (html) => html.replace(/<[^>]*\bdata-pg-only\b[^>]*>\s*/g, ''),
  },
})

// base './' keeps asset paths relative so GitHub Pages project hosting just works
export default defineConfig({
  base: './',
  plugins: [tailwindcss(), stripPgOnly()],
})
