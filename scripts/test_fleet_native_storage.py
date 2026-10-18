import hashlib
import importlib.util
import json
import os
import stat
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('native_storage',Path(__file__).with_name('fleet-native-storage.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)


class Tests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name).resolve();self.repo=self.root/'repo';self.repo.mkdir()
        self.git(self.repo,'init','-b','main');self.git(self.repo,'config','user.email','test@example.invalid');self.git(self.repo,'config','user.name','test')
        (self.repo/'.gitignore').write_text('node_modules/\ntest-results/\n')
        (self.repo/'package-lock.json').write_text('{"lockfileVersion":3}')
        (self.repo/'source.txt').write_text('retained exact source')
        self.git(self.repo,'add','.');self.git(self.repo,'commit','-m','fixture')
        self.head=self.git(self.repo,'rev-parse','HEAD');self.work=self.root/'capture/desktop'
        self.git(self.repo,'worktree','add','--detach',str(self.work),self.head)
        self.task={'id':'a'*64,'ticket':'pyrycode/pyrycode-desktop#1975','request':{'recipe':'desktop-fake-suite','revision':self.head}}
        self.put('node_modules/pkg/a.js',b'rebuildable A');self.put('node_modules/pkg/b.js',b'rebuildable B')
        self.put('test-results/failure.log',b'unique complete failure evidence')
        self.attestation=m.installation(self.task,self.work)
        self.allowed=True;self.users=[];self.exclusive=True
        self.cleaner=m.NativeDependencies(lambda request:{'allowed':self.allowed,'exclusive':self.exclusive,'lease':'native-lease'},lambda path:self.users)

    def git(self,path,*args):return subprocess.check_output(['git','-C',str(path),*args],stderr=subprocess.DEVNULL).decode().strip()
    def put(self,path,data):
        p=self.work/path;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(data);return p
    def clean(self,**kwargs):return self.cleaner.cleanup(str(self.repo),str(self.work),self.task,self.attestation,**kwargs)

    def test_selective_verified_leaves_preserve_modified_unknown_source_evidence_and_all_refs(self):
        self.put('node_modules/pkg/b.js',b'local diagnosis modification')
        unknown=self.put('node_modules/pkg/failed-run.log',b'unknown unique capture')
        source=(self.work/'source.txt').read_bytes();evidence=(self.work/'test-results/failure.log').read_bytes();refs=self.git(self.repo,'show-ref')
        result=self.clean(apply=True)
        self.assertEqual(result['state'],'reclaimed');self.assertEqual(result['filesRemoved'],1)
        self.assertFalse((self.work/'node_modules/pkg/a.js').exists())
        self.assertEqual((self.work/'node_modules/pkg/b.js').read_bytes(),b'local diagnosis modification')
        self.assertEqual(unknown.read_bytes(),b'unknown unique capture');self.assertTrue(result['held'])
        self.assertEqual((self.work/'source.txt').read_bytes(),source);self.assertEqual((self.work/'test-results/failure.log').read_bytes(),evidence)
        self.assertEqual(self.git(self.repo,'show-ref'),refs);self.assertEqual(self.git(self.work,'rev-parse','HEAD'),self.head)
        self.assertEqual(self.clean(apply=True)['filesRemoved'],0)

    def test_active_uncertain_or_nonexclusive_custody_never_deletes(self):
        for users,allowed,exclusive in [([123],True,True),(None,True,True),([],False,True),([],True,False)]:
            self.users,self.allowed,self.exclusive=users,allowed,exclusive
            result=self.clean(apply=True);self.assertEqual(result['filesRemoved'],0);self.assertTrue(result['held'])
            self.assertTrue((self.work/'node_modules/pkg/a.js').exists())

    def test_wrong_revision_changed_lock_and_untrusted_manifest_are_held(self):
        for key,value in [('revision','f'*40),('origin','newly-invented'),('referenceDigest','b'*64)]:
            original=self.attestation[key];self.attestation[key]=value
            self.assertEqual(self.clean(apply=True)['filesRemoved'],0);self.attestation[key]=original
        (self.work/'package-lock.json').write_text('different requirements')
        self.assertEqual(self.clean(apply=True)['filesRemoved'],0)

    def test_symlink_leaf_is_unlinked_without_touching_target_and_hardlinks_stay(self):
        outside=self.root/'outside';outside.write_bytes(b'outside capture')
        link=self.work/'node_modules/pkg/link';link.symlink_to(outside)
        self.attestation=m.installation(self.task,self.work)
        os.link(self.work/'node_modules/pkg/b.js',self.root/'retained-hardlink')
        result=self.clean(apply=True)
        self.assertFalse(link.exists());self.assertEqual(outside.read_bytes(),b'outside capture')
        self.assertTrue((self.work/'node_modules/pkg/b.js').exists());self.assertTrue(result['held'])

    def test_replaced_ancestor_symlink_never_deletes_outside_bytes(self):
        outside=self.root/'outside';outside.mkdir();(outside/'a.js').write_bytes(b'unique outside evidence')
        (self.work/'node_modules/pkg').rename(self.work/'node_modules/retained-pkg')
        (self.work/'node_modules/pkg').symlink_to(outside,target_is_directory=True)
        result=self.clean(apply=True)
        self.assertEqual(result['filesRemoved'],0);self.assertEqual((outside/'a.js').read_bytes(),b'unique outside evidence')

    def test_root_swap_at_unlink_is_anchored_and_outside_evidence_survives(self):
        outside=self.root/'outside';outside.mkdir();self.put('node_modules/pkg/unused',b'preserved')
        (outside/'node_modules/pkg').mkdir(parents=True);(outside/'node_modules/pkg/a.js').write_bytes(b'outside evidence')
        unlink=os.unlink;swapped=[False]
        def swap(path,*args,**kwargs):
            if not swapped[0]:
                swapped[0]=True;self.work.rename(self.work.with_name('retained-desktop'));self.work.symlink_to(outside,target_is_directory=True)
            return unlink(path,*args,**kwargs)
        with patch.object(m.os,'unlink',side_effect=swap):result=self.clean(apply=True)
        self.assertEqual((outside/'node_modules/pkg/a.js').read_bytes(),b'outside evidence');self.assertTrue(result['held'])

    def test_partial_unlink_reports_exact_work_and_retry_removes_only_remaining_matches(self):
        unlink=os.unlink;count=[0]
        def fail_second(path,*args,**kwargs):
            count[0]+=1
            if count[0]==2:raise PermissionError('injected unlink failure')
            return unlink(path,*args,**kwargs)
        with patch.object(m.os,'unlink',side_effect=fail_second):result=self.clean(apply=True)
        self.assertEqual(result['filesRemoved'],1);self.assertEqual(result['reclaimedBytes'],len(b'rebuildable A'));self.assertTrue(result['held'])
        retry=self.clean(apply=True);self.assertEqual(retry['filesRemoved'],1)
        self.assertEqual((self.work/'test-results/failure.log').read_bytes(),b'unique complete failure evidence')

    def test_missing_reference_leaf_is_retry_safe_and_unsafe_path_cannot_escape(self):
        (self.work/'node_modules/pkg/a.js').unlink()
        self.assertEqual(self.clean(apply=True)['filesRemoved'],1)
        self.attestation['reference']['entries']=[{'path':'node_modules/../../source.txt','kind':'file'}]
        self.attestation['referenceDigest']=m.digest(self.attestation['reference'])
        self.assertEqual(self.clean(apply=True)['filesRemoved'],0)
        self.assertEqual((self.work/'source.txt').read_text(),'retained exact source')

    def test_unknown_authority_failure_is_held_without_losing_partial_accounting(self):
        calls=[0]
        def guard(request):
            calls[0]+=1
            if calls[0]>1:raise RuntimeError('lost authority')
            return {'allowed':True,'exclusive':True,'lease':'native-lease'}
        self.cleaner.authority=guard
        with patch.object(m.time,'monotonic',side_effect=range(100)):
            result=self.clean(apply=True)
        self.assertTrue(result['held']);self.assertLessEqual(result['filesRemoved'],1)

    def test_fresh_preunlink_authority_refusal_ends_attempt_even_if_later_checks_would_allow(self):
        calls=[0]
        def guard(request):
            calls[0]+=1
            return {'allowed':calls[0]!=2,'exclusive':True,'lease':'native-lease'}
        self.cleaner.authority=guard
        with patch.object(m.time,'monotonic',side_effect=[0,1,3,4,5,6,9]):result=self.clean(apply=True)
        self.assertEqual(calls[0],2);self.assertEqual(result['filesRemoved'],0);self.assertTrue(result['held'])
        self.assertTrue((self.work/'node_modules/pkg/a.js').exists());self.assertTrue((self.work/'node_modules/pkg/b.js').exists())

    def test_dependency_parent_on_another_filesystem_is_preserved(self):
        fstat=os.fstat;root_inode=self.work.stat().st_ino
        def foreign_parent(fd):
            value=fstat(fd)
            if stat.S_ISDIR(value.st_mode) and value.st_ino!=root_inode:
                fields=list(value);fields[2]=value.st_dev+1;return os.stat_result(fields)
            return value
        with patch.object(m.os,'fstat',side_effect=foreign_parent):result=self.clean(apply=True)
        self.assertEqual(result['filesRemoved'],0);self.assertTrue(result['held'])
        self.assertTrue((self.work/'node_modules/pkg/a.js').exists())

if __name__=='__main__':unittest.main()
