module.exports = {
  darkMode: 'class', // Manual toggle with class
  content: [
    "./index.html",
    "./src/**/*.{js,jsx,ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        primary: {
          50:  '#fff1f4',
          100: '#ffe4ea',
          200: '#ffb8c7',
          300: '#ff8ba3',
          400: '#ff5e80',
          500: '#e10c3e', 
          DEFAULT: '#e10c3e', 
        },
        secondary: {
          50: '#eff6ff',
          DEFAULT: '#2147d9',
        },
        text: '#333',
        dark: '#111727',
        'subtext': '#6c757d',
        'lightgray': '#eaeaea',
      },
      fontSize: {
        desktop: '0.95rem',
        mobile: '0.8rem',
      },
      width: {
        sidebar: '20rem',
      },
      margin: {
        'container-w': '2vw',
        'container-h': '2vh',
      },
      padding: {
        'container-w': '2vw',
        'container-h': '2vh',
      }
    },
  },
  plugins: [],
} 