import sys
if sys.version_info[0] != 3 or sys.version_info[1] < 6:
	exit(4)
try:
	import inmantals.pipeserver
	sys.exit(0)
except:
	sys.exit(3)
