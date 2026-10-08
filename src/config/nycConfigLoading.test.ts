import fs from 'fs';
import os from 'os';
import path from 'path';

type NycConfig = {
  cwd: string;
  include?: string[];
  exclude?: string[];
  extension?: string[];
};

type LoadNycConfig = (options: { cwd: string; nycrcPath: string }) => Promise<NycConfig>;

const { loadNycConfig } = require('@istanbuljs/load-nyc-config') as {
  loadNycConfig: LoadNycConfig;
};

describe('NYC YAML configuration loading', () => {
  it('loads YAML arrays and an extended configuration', async () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'nvf-nyc-config-'));

    try {
      fs.writeFileSync(
        path.join(tempDirectory, 'base.nycrc.yml'),
        ['exclude:', '  - generated/**', ''].join('\n'),
      );
      fs.writeFileSync(
        path.join(tempDirectory, '.nycrc.yml'),
        [
          'extends: ./base.nycrc.yml',
          'include:',
          '  - src/**/*.ts',
          'extension:',
          '  - .ts',
          '',
        ].join('\n'),
      );

      const config = await loadNycConfig({
        cwd: tempDirectory,
        nycrcPath: '.nycrc.yml',
      });

      expect(config.cwd).toBe(tempDirectory);
      expect(config.include).toEqual(['src/**/*.ts']);
      expect(config.exclude).toEqual(['generated/**']);
      expect(config.extension).toEqual(['.ts']);
    } finally {
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
  });
});
