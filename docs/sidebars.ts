import type { SidebarsConfig } from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  guide: [
    'intro',
    'installation',
    {
      type: 'category',
      label: 'Guides',
      items: ['signing', 'verifying', 'keys'],
    },
    'vendor',
  ],
};

export default sidebars;
