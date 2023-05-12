import yappi

class MockCProfile:
    def enable(self) -> None:
        yappi.start()

    def disable(self) -> None:
        yappi.stop()

    def dump_stats(self, f) -> None:
        yappi.get_func_stats().save(f, type="pstat")


import cProfile
cProfile.Profile = MockCProfile
