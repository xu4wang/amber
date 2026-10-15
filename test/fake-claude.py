#!/usr/bin/python3
# A stand-in for `claude -p` in tests: records how it was started, answers like the real CLI's --output-format json.
import json, os, sys, time
prompt = sys.stdin.read()
args = sys.argv[1:]
with open('calls.jsonl', 'a') as f:   # in the working directory Amber gave it
    f.write(json.dumps({'args': args, 'env': sorted(os.environ.keys()), 'cwd': os.getcwd()}) + '\n')
model = args[args.index('--model') + 1] if '--model' in args else ''
system = args[args.index('--system-prompt') + 1] if '--system-prompt' in args else ''
if 'SLEEP' in prompt:
    time.sleep(30)
if 'FAIL' in prompt:
    print(json.dumps({'type': 'result', 'is_error': True, 'result': 'model said no'}))
    sys.exit(1)
print(json.dumps({'type': 'result', 'is_error': False, 'session_id': 'sess-1', 'result': 'summary[%s|%s] of %d chars' % (model, system, len(prompt))}))
