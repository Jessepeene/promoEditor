/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: { 950: '#07070a', 900: '#0d0d12', 850: '#121219', 800: '#181822', 700: '#232331', 600: '#33334a' },
        tag1: '#3b82f6',
        tag2: '#f59e0b',
        tag3: '#ef4444',
        tag4: '#a855f7',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'Segoe UI', 'sans-serif'],
        mono: ['JetBrains Mono', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
};
