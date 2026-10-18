import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('dependency_support',Path(__file__).with_name('fleet-support.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class Tests(unittest.TestCase):
    def fixture(self,root):
        supervisor=m.SupportSupervisor(None,{'stateDirectory':str(root)})
        directory=root/'capture';directory.mkdir()
        identity='a'*64
        m.atomic(directory/'task.json',{'id':identity,'request':{'recipe':'desktop-fake-suite'}})
        m.atomic(directory/'result.json',{'outcome':'completed','files':{'full-failed-report.txt':'all original diagnostics'}})
        (directory/'source').write_bytes(b'original source');(directory/'node_modules').mkdir();(directory/'node_modules/installed.js').write_bytes(b'installed dependency')
        receipt=supervisor.directory/(identity+'.receipt.json')
        old={'id':identity,'phase':'complete','directory':str(directory),'result':str(directory/'result.json'),'artifactDigest':'b'*64,'drainConfirmed':True}
        m.atomic(receipt,old)
        return supervisor,directory,receipt,old

    def test_publication_signals_separate_worker_once_without_hashing_deleting_or_launching(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp).resolve();s,directory,receipt,old=self.fixture(root)
            before={p:p.read_bytes() for p in directory.rglob('*') if p.is_file()}
            with patch.object(m.subprocess,'Popen') as spawn:
                s.schedule_dependency_cleanup(receipt,old)
                marker=root/'storage/native-completion.json';self.assertTrue(marker.exists());first=marker.read_bytes()
                s.schedule_dependency_cleanup(receipt,old);spawn.assert_not_called()
            self.assertEqual(marker.read_bytes(),first);self.assertEqual({p:p.read_bytes() for p in before},before)
            self.assertTrue(json.loads(receipt.read_text())['dependencyCleanupScheduled'])

    def test_attention_failed_or_missing_drain_does_not_signal_automatic_cleanup(self):
        for change in [{'phase':'attention'},{'drainConfirmed':False},{'artifactDigest':None},{'interrupted':True}]:
            with tempfile.TemporaryDirectory() as tmp:
                root=Path(tmp).resolve();s,directory,receipt,old=self.fixture(root)
                s.schedule_dependency_cleanup(receipt,{**old,**change})
                self.assertFalse((root/'storage/native-completion.json').exists())

if __name__=='__main__':unittest.main()
