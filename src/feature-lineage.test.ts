import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseFeatureRoot, featureRootIssueNumber } from './feature-lineage.js';
import { resolveFamilyRoot, collectOffBoardFamilyRoots } from './pipeline-decisions.js';

test('a recovery descendant keeps the original root beyond the two-level snapshot', () => {
  const item = { issueNumber: 104, parentNumber: 103, grandparentNumber: 102,
    body: '<!-- ticket-scope-policy: behaviour-slices-v1 -->\n<!-- feature-root: pyrycode/pyrycode#100 -->',
    url: 'https://github.com/pyrycode/pyrycode/issues/104' };
  assert.equal(resolveFamilyRoot(item), 100);
  assert.deepEqual([...collectOffBoardFamilyRoots([item, { ...item, issueNumber: 105 }], new Map())], [100]);
});

test('durable lineage survives a body refresh without the temporary marker', () => {
  assert.equal(resolveFamilyRoot({ issueNumber: 104, parentNumber: 103, grandparentNumber: 102,
    featureRoot: 'pyrycode/pyrycode#100', body: 'Refined body' }), 100);
});

test('legacy parent snapshots retain their existing root interpretation', () => {
  assert.equal(resolveFamilyRoot({ issueNumber: 104, parentNumber: 103, grandparentNumber: 102,
    body: 'Split from #100. Blocked by #99.' }), 102);
});

test('feature roots are complete references, not a partial number or fenced example', () => {
  assert.equal(parseFeatureRoot('No family marker'), undefined);
  assert.equal(parseFeatureRoot('```markdown\n<!-- feature-root: pyrycode/pyrycode#100 -->\n```'), undefined);
  assert.equal(parseFeatureRoot('~~~\n<!-- feature-root: pyrycode/pyrycode#100 -->\n~~~'), undefined);
  assert.equal(parseFeatureRoot('<!-- feature-root: pyrycode/pyrycode#100 -->\r\n', 'PYRYCODE/PYRYCODE'), 'pyrycode/pyrycode#100');
  assert.equal(featureRootIssueNumber('pyrycode/pyrycode#100'), 100);
});

test('malformed and conflicting roots fail closed', () => {
  for (const reference of ['#100', 'pyrycode/pyrycode#0', 'pyrycode/pyrycode#-1', 'pyrycode/pyrycode#1junk', 'pyrycode/pyrycode#9007199254740992']) {
    assert.throws(() => featureRootIssueNumber(reference), /feature root/i);
    assert.throws(() => parseFeatureRoot(`<!-- feature-root: ${reference} -->`), /feature root/i);
  }
  assert.throws(() => parseFeatureRoot('<!-- feature-root: pyrycode/pyrycode#100 -->\n<!-- feature-root: pyrycode/pyrycode#99 -->'), /conflicting/i);
  assert.throws(() => parseFeatureRoot('<!-- feature-root: pyrycode/pyrycode#100'), /feature root/i);
  assert.throws(() => resolveFamilyRoot({ issueNumber: 104, featureRoot: '#100' }), /feature root/i);
});

test('a root cannot silently move to another repository or disagree with retained lineage', () => {
  const body = '<!-- feature-root: pyrycode/pyrycode#100 -->';
  assert.throws(() => parseFeatureRoot(body, 'pyrycode/pyrycode-mobile'), /repository/i);
  assert.throws(() => resolveFamilyRoot({ issueNumber: 104, body,
    url: 'https://github.com/pyrycode/pyrycode-mobile/issues/104' }), /repository/i);
  assert.throws(() => resolveFamilyRoot({ issueNumber: 104, featureRoot: 'pyrycode/pyrycode#99', body }), /conflicting/i);
});
