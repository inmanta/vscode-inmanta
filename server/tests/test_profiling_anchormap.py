import itertools
import logging
import os
from typing import List, Callable, Iterator, Tuple, TypeVar

from intervaltree import IntervalTree

logger = logging.getLogger(__name__)


T = TypeVar("T")
S = TypeVar("S")

def groupby(mylist: List[T], f: Callable[[T], S]) -> Iterator[Tuple[S, Iterator[T]]]:
    return itertools.groupby(sorted(mylist, key=f), f)

def test_profiling_dummy():

    class MockLSHandler(anchor):
        def flatten(self, line, char):
            """convert linenr char combination into a single number"""
            assert char < 100000
            return line * 100000 + char

        def compile_and_anchor(self):
            def treeify(iterator):
                tree = IntervalTree()
                for f, t in iterator:
                    start = self.flatten(f.lnr - 1, f.start_char - 1)
                    end = self.flatten(f.end_lnr - 1, f.end_char - 1)
                    tree[start:end] = t
                return tree

            def compute_anchormap(anchormap):
                self.anchormap = {}
                for k, v in groupby(anchormap, lambda x: x[0].file):
                    if self.tmp_project:
                        k = self.replace_tmp_path(k)
                    self.anchormap[os.path.realpath(k)] = treeify(v)

            compute_anchormap(anchormap)

            def log_keys(dico):
                for k in dico.keys():
                    logger.debug(k)
            logger.debug("anchormap")
            log_keys(self.anchormap)
            logger.debug("="*30)

            # logger.debug(self.anchormap)
            def treeify_reverse(iterator):
                tree = IntervalTree()
                for f, t in iterator:
                    if isinstance(t.location, Range):
                        start = self.flatten(t.location.lnr - 1, t.location.start_char - 1)
                        end = self.flatten(t.location.end_lnr - 1, t.location.end_char - 1)
                        if start <= end:
                            tree[start:end] = f
                return tree

            def compute_reverse_anchormap(anchormap):
                self.reverse_anchormap = {}
                for k, v in groupby(anchormap, lambda x: x[1].location.file):
                    if self.tmp_project:
                        k = self.replace_tmp_path(k)
                    self.reverse_anchormap[os.path.realpath(k)] = treeify_reverse(v)

            compute_reverse_anchormap(anchormap)
            logger.debug("rev anchormap")
            log_keys(self.reverse_anchormap)
            logger.debug("="*30)
