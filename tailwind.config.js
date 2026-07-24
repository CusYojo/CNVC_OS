/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#172033',
        brand: {
          50: '#f1f6ff',
          100: '#e4edff',
          500: '#3977e8',
          600: '#2d66d2',
          700: '#2452ac',
          900: '#142d5f',
        },
      },
      boxShadow: {
        card: '0 1px 2px rgba(20, 45, 95, .04), 0 8px 24px rgba(20, 45, 95, .05)',
      },
    },
  },
  plugins: [],
}
