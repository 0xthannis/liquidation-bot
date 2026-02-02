/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'dark': {
          900: '#0a0a0f',
          800: '#12121a',
          700: '#1a1a25',
          600: '#252533',
        },
        'accent': {
          purple: '#8b5cf6',
          blue: '#3b82f6',
          cyan: '#06b6d4',
          green: '#10b981',
          red: '#ef4444',
          orange: '#f97316',
          yellow: '#eab308',
        }
      },
      fontFamily: {
        'mono': ['JetBrains Mono', 'Fira Code', 'monospace'],
        'sans': ['Inter', 'system-ui', 'sans-serif'],
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'glow': 'glow 2s ease-in-out infinite alternate',
      },
      keyframes: {
        glow: {
          '0%': { boxShadow: '0 0 5px rgba(139, 92, 246, 0.5)' },
          '100%': { boxShadow: '0 0 20px rgba(139, 92, 246, 0.8)' },
        }
      }
    },
  },
  plugins: [],
}
