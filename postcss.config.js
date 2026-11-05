import tailwindcss from '@tailwindcss/postcss';
import prefixSelector from 'postcss-prefix-selector';

// Compile only the PH entry point. Other routes keep their original CSS.
export default {
  plugins: [
    tailwindcss(),
    prefixSelector({
      prefix: '.ph-ui',
      includeFiles: [/ph-ui\.css$/],
      transform(prefix, selector, prefixedSelector) {
        if (selector === prefix) return selector;
        if (selector === ':root' || selector === 'html' || selector === 'body') return prefix;
        if (selector === '.dark') return `${prefix}.dark`;
        if (selector.startsWith('.dark ')) return `${prefix}${selector}`;
        return prefixedSelector;
      },
    }),
  ],
};
