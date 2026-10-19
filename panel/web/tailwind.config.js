// EaseCab brand tokens. Airy light: white surfaces, one blue accent, slate text.
export default {
  content: ['./index.html', './src/**/*.jsx'],
  theme: {
    extend: {
      colors: {
        brand: { DEFAULT: '#2563EB', deep: '#1E40AF', navy: '#1E3A8A', sky: '#EFF4FF' },
        bg: '#F8FAFC',
        line: '#E2E8F0',
        ink: { DEFAULT: '#0F172A', 60: '#64748B', 40: '#94A3B8' },
        ok: '#10B981', warn: '#F59E0B', bad: '#EF4444', wa: '#25D366',
      },
      fontFamily: { sans: ['Inter', 'system-ui', 'sans-serif'] },
      boxShadow: { card: '0 1px 2px rgba(15,23,42,.04), 0 1px 3px rgba(15,23,42,.06)' },
    },
  },
};
