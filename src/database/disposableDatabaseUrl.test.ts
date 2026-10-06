const { parseDisposableDatabaseUrl } = require('../../scripts/disposableDatabaseUrl') as {
  parseDisposableDatabaseUrl: (databaseUrl: string) => { databaseName: string; port: number };
};

describe('disposable PostgreSQL URL guard', () => {
  it('accepts an explicit loopback target', () => {
    expect(parseDisposableDatabaseUrl('postgres://postgres@127.0.0.1:55440/nvf_award_test_guard'))
      .toEqual({ databaseName: 'nvf_award_test_guard', port: 55440 });
  });

  it.each([
    ['query authority override', 'postgres://postgres@127.0.0.1:55440/nvf_award_test_guard?host=remote.example'],
    ['fragment', 'postgres://postgres@127.0.0.1:55440/nvf_award_test_guard#remote'],
    ['remote host', 'postgres://postgres@192.0.2.10:55440/nvf_award_test_guard'],
    ['default port', 'postgres://postgres@127.0.0.1/nvf_award_test_guard'],
  ])('rejects %s', (_description, databaseUrl) => {
    expect(() => parseDisposableDatabaseUrl(databaseUrl)).toThrow('refusing non-disposable database target');
  });
});
