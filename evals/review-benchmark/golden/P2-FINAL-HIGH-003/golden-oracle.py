#!/usr/bin/env python3
"""Independent oracle for the golden historical item's packet, prompt and grounding.

Reads git and the golden fixtures, and writes, per side, the masked packet sources under
`<side>/round-trip/`, `packet-sources.sha256`, `packet.sha256` and `prompt.sha256`, the
`roundTrip` record of `item.json`, and `expected-grounding.json`. Nothing here imports or runs
the repository's TypeScript: the recipe of plan §7.8 (rule-P diff sections, finding-id masking,
the corpus packet with its NOT_RECORDED execution, canonical JSON, the nonce, the datamarked
blocks, the output schema and the finding fingerprint) is implemented again from its
description, so the application and evals tests compare the code under test with values it did
not produce. Only the instruction text is read from `prompt.ts`: it is the template the digest
pins, and any change to it changes the prompt digest. The chunk lists (`<side>/chunks.json`) and
the grounding outcomes below are written by hand.

Run from the repository root: python3 evals/review-benchmark/golden/P2-FINAL-HIGH-003/golden-oracle.py
The tests never run it; they check what it wrote.
"""

import hashlib
import json
import os
import re
import subprocess

ROOT = os.getcwd()
GOLDEN = 'evals/review-benchmark/golden/P2-FINAL-HIGH-003'
FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv', '--find-renames', '--unified=3']
MAX_BYTES = 400000
FINDING_ID = re.compile(rb'\bP[0-9]+-[A-Z0-9]+(?:-[A-Z0-9]+)*-[0-9]{3}\b|\b(?:CRIT|CRITICAL|HIGH|MED|MEDIUM|LOW)-[0-9]{3}\b')
LINE_BREAK = re.compile('\r\n|[\n\r\u0085\u2028\u2029]')

# Grounding outcomes, by hand: every finding cites a file of the chunk with evidence of 81 and a required fix of 63
# characters (minimums 40 and 20); every line is inside its post-image (execute-task.ts has 199 lines reviewed,
# 204 post-fix; index.ts 56 and 78) except outside-file's line 900.
GROUNDED = {'grounded': True, 'reason': None}
GROUNDING = {
    'exact': GROUNDED,
    'near': GROUNDED,
    'far': GROUNDED,
    'wrong-category': GROUNDED,
    'other-file': GROUNDED,
    'outside-file': {'grounded': False, 'reason': 'lines-outside-file'},
}


def git(*args):
    return subprocess.run(['git', *args], cwd=ROOT, check=True, capture_output=True).stdout


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def mask(data):
    count = 0

    def x(m):
        nonlocal count
        count += 1
        return b'X' * len(m.group(0))

    return FINDING_ID.sub(x, data), count


def sections(diff):
    """The whole diff's file sections by path (old side; every file here is added, so it is its own path)."""
    out = {}
    starts = [m.start() for m in re.finditer(rb'^diff --git ', diff, re.M)]
    for k, start in enumerate(starts):
        section = diff[start:starts[k + 1] if k + 1 < len(starts) else len(diff)]
        head = re.match(rb'diff --git a/(.*) b/(.*)\n', section)
        out[head.group(1).decode()] = section
    return out


def spotlight(nonce, part, text):
    lines = [] if text == '' else LINE_BREAK.split(text)
    if lines and lines[-1] == '' and LINE_BREAK.search(text[-2:]):
        lines.pop()
    return '\n'.join([f'<<<UNTRUSTED {nonce} {part}>>>', *[f'{nonce}| {line}' for line in lines], f'<<<END {nonce} {part}>>>'])


def nullable(kind):
    return {'type': [kind, 'null']}


CATEGORIES = ['SPEC', 'ARCHITECTURE', 'CORRECTNESS', 'SECURITY', 'PERFORMANCE', 'TEST_QUALITY', 'MAINTAINABILITY', 'EVIDENCE_INTEGRITY']
OUTPUT_SCHEMA = {
    'type': 'object',
    'additionalProperties': False,
    'required': ['verdict', 'findings', 'priorFindingClaims', 'packetAssessment'],
    'properties': {
        'verdict': {'type': 'string', 'enum': ['APPROVE', 'REQUEST_CHANGES', 'ESCALATE']},
        'findings': {
            'type': 'array',
            'items': {
                'type': 'object',
                'additionalProperties': False,
                'required': ['key', 'severity', 'category', 'file', 'lineStart', 'lineEnd', 'requirementId', 'evidence', 'requiredFix', 'confidence'],
                'properties': {
                    'key': {'type': 'string'},
                    'severity': {'type': 'string', 'enum': ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']},
                    'category': {'type': 'string', 'enum': CATEGORIES},
                    'file': nullable('string'),
                    'lineStart': nullable('integer'),
                    'lineEnd': nullable('integer'),
                    'requirementId': nullable('string'),
                    'evidence': {'type': 'string'},
                    'requiredFix': {'type': 'string'},
                    'confidence': {'type': 'number'},
                },
            },
        },
        'priorFindingClaims': {
            'type': 'array',
            'items': {
                'type': 'object',
                'additionalProperties': False,
                'required': ['priorFindingId', 'status', 'evidence', 'resolutionFile', 'resolutionLine'],
                'properties': {
                    'priorFindingId': {'type': 'string'},
                    'status': {'type': 'string', 'enum': ['RESOLVED', 'PARTIAL', 'OPEN']},
                    'evidence': {'type': 'string'},
                    'resolutionFile': nullable('string'),
                    'resolutionLine': nullable('integer'),
                },
            },
        },
        'packetAssessment': {
            'type': 'object',
            'additionalProperties': False,
            'required': ['coverage', 'notes'],
            'properties': {'coverage': {'type': 'string', 'enum': ['complete', 'partial']}, 'notes': {'type': 'string'}},
        },
    },
}


def fingerprint(finding):
    """sha256 of the canonical JSON of [category, file, line bucket of 10, rule id]; a model finding has no rule id."""
    bucket = None if finding['lineStart'] is None else finding['lineStart'] // 10
    return sha256(canonical([finding['category'], finding['file'], bucket, None]).encode())


def main():
    item_path = os.path.join(ROOT, GOLDEN, 'item.json')
    item = json.load(open(item_path, encoding='utf-8'))
    synthetic = item['synthetic']
    template = re.search(r'const INSTRUCTIONS_TEMPLATE = `([^`]*)`;', open(os.path.join(ROOT, 'packages/application/src/assurance/prompt.ts'), encoding='utf-8').read()).group(1)
    previous = item['roundTrip']['sides']
    sides = {}
    for side, result in (('reviewed', item['reviewedSha']), ('post-fix', item['postFixSha'])):
        [chunk] = json.load(open(os.path.join(ROOT, GOLDEN, side, 'chunks.json'), encoding='utf-8'))
        whole = sections(git('diff', *FLAGS, item['baseSha'], result))
        diff, diff_masked = mask(b''.join(whole[path] for path in chunk['files']))
        parts = [('round-trip/diff', diff)]
        files = []
        for i, path in enumerate(chunk['files']):
            post, masked = mask(git('show', f'{result}:{path}'))
            text = post.decode('utf-8')
            line_count = len(text[:-1].split('\n')) if text.endswith('\n') else len(text.split('\n'))
            parts.append((f'round-trip/file-{i}', post))
            files.append({'path': path, 'status': 'A', 'part': f'{side}/round-trip/file-{i}', 'sha256': sha256(post), 'bytes': len(post), 'lineCount': line_count, 'masked': masked})
        os.makedirs(os.path.join(ROOT, GOLDEN, side, 'round-trip'), exist_ok=True)
        for name, data in parts:
            open(os.path.join(ROOT, GOLDEN, side, name), 'wb').write(data)
        listing = ''.join(f'{sha256(data)}  {name}\n' for name, data in parts)
        open(os.path.join(ROOT, GOLDEN, side, 'packet-sources.sha256'), 'w', encoding='utf-8').write(listing)

        attempt = previous[side]['attempt']
        packet = {
            'packetVersion': 'review-packet/v1',
            'identity': {
                **{k: synthetic['identity'][k]['id'] for k in ('organizationId', 'projectId', 'repositoryBindingId', 'runId', 'taskId')},
                'attemptId': attempt['id'],
                'round': synthetic['round'],
                'roundKey': f"{attempt['id']}:assurance:{synthetic['round']}",
            },
            'risk': synthetic['risk'],
            'reviewKind': synthetic['reviewKind'],
            'workOrder': synthetic['workOrder'],
            'change': {
                'taskBaseSha': item['baseSha'],
                'resultSha': result,
                'repairBaseSha': None,
                'cumulativeDiff': {'artifactId': sha256(diff), 'sha256': sha256(diff), 'kind': 'review-diff'},
                'repairDelta': None,
                'files': [
                    {'path': f['path'], 'status': f['status'], 'binary': False, 'postImage': {'artifactId': f['sha256'], 'sha256': f['sha256'], 'kind': 'review-blob'}, 'lineCount': f['lineCount'], 'omittedReason': None}
                    for f in files
                ],
            },
            'execution': synthetic['execution'],
            'priorFindings': [],
            'budget': {'maxBytes': MAX_BYTES, 'overBudget': False, 'omissions': []},
        }
        packet_text = canonical(packet)
        packet_bytes = packet_text.encode('utf-8')
        open(os.path.join(ROOT, GOLDEN, side, 'packet.sha256'), 'w', encoding='utf-8').write(f'{sha256(packet_bytes)}  packet\n')

        nonce = sha256(packet_bytes)[:16]
        blocks = [spotlight(nonce, 'packet', packet_text), spotlight(nonce, 'diff', diff.decode('utf-8'))]
        blocks += [spotlight(nonce, f'file-{i}', data.decode('utf-8')) for i, (_, data) in enumerate(parts[1:])]
        prompt = {'templateVersion': 'review-prompt/v1', 'instructions': template.replace('{nonce}', nonce), 'input': '\n\n'.join(blocks), 'outputSchema': OUTPUT_SCHEMA}
        prompt_bytes = canonical(prompt).encode('utf-8')
        assert len(prompt_bytes) <= MAX_BYTES, len(prompt_bytes)
        open(os.path.join(ROOT, GOLDEN, side, 'prompt.sha256'), 'w', encoding='utf-8').write(f'{sha256(prompt_bytes)}  prompt\n')

        sides[side] = {
            'chunk': chunk['id'],
            'attempt': attempt,
            'taskBaseSha': item['baseSha'],
            'resultSha': result,
            'diff': {'part': f'{side}/round-trip/diff', 'sha256': sha256(diff), 'bytes': len(diff), 'masked': diff_masked},
            'files': files,
        }
        print(side, 'packet', sha256(packet_bytes), 'prompt', sha256(prompt_bytes), len(prompt_bytes), 'bytes')

    item['roundTrip'] = {
        'description': (
            "One corpus packet per side for a chunk chosen by hand (each side's chunks.json): the item's three cited files "
            'and the file the other-file output cites. Its sources are those files\' sections of the cycle\'s rule-P diff '
            'and their post-images, finding-id tokens masked. packet-sources.sha256, packet.sha256 and prompt.sha256 are '
            'computed by golden-oracle.py, an implementation of the recipe independent of the code under test. Per-cycle '
            'chunking over the full cycle source comes with the packet plan.'
        ),
        'maxBytes': MAX_BYTES,
        'sides': sides,
    }
    open(item_path, 'w', encoding='utf-8').write(json.dumps(item, indent=2, ensure_ascii=False) + '\n')

    expected = {
        'note': 'Per side, output and finding key: the grounding outcome (by hand) and the fingerprint (golden-oracle.py).',
    }
    for side in ('reviewed', 'post-fix'):
        expected[side] = {}
        for name in sorted(os.listdir(os.path.join(ROOT, GOLDEN, 'outputs', side))):
            output = json.load(open(os.path.join(ROOT, GOLDEN, 'outputs', side, name), encoding='utf-8'))
            expected[side][name[:-5]] = {f['key']: {**GROUNDING[f['key']], 'fingerprint': fingerprint(f)} for f in output['findings']}
    open(os.path.join(ROOT, GOLDEN, 'expected-grounding.json'), 'w', encoding='utf-8').write(json.dumps(expected, indent=2) + '\n')


main()
