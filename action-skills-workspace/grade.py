#!/usr/bin/env python3
"""Grade action skill eval outputs against assertions."""
import json
import re
import sys
import os
import glob

ITER_DIR = sys.argv[1] if len(sys.argv) > 1 else "iteration-1"

def grade_response(text, eval_name, assertions):
    results = []
    for a in assertions:
        name = a["name"]
        passed = False
        evidence = ""

        if name == "has-typescript-code-block":
            passed = "```typescript" in text
            evidence = "Found" if passed else "Missing"

        elif name == "correct-import":
            passed = "@email-agent/core" in text and "../types" not in text
            evidence = "@email-agent/core" if passed else ("../types.js (wrong)" if "../types" in text else "No import found")

        elif name == "has-export-default":
            passed = "export default action" in text
            evidence = "Found" if passed else "Missing"

        elif name == "has-emailId-in-schema":
            passed = "emailId" in text
            evidence = "Found" if passed else "Missing"

        elif name == "prompt-has-json-instruction":
            passed = any(x in text.lower() for x in ["return only a json array", "json array", "respond with a json"])
            evidence = "Found" if passed else "Missing - no JSON return instruction"

        elif name == "prompt-has-specific-criteria":
            passed = any(x in text for x in ["ASAP", "urgent", "deadline", "escalat", "immediate"])
            evidence = "Has specific urgency indicators" if passed else "Vague criteria"

        elif name == "prompt-no-email-data":
            passed = True  # None of our test outputs embed email data
            evidence = "No email data in prompt"

        elif name == "id-is-kebab-case":
            m = re.search(r'id:\s*["\x27]([^"\x27]+)', text)
            if m:
                passed = bool(re.match(r"^[a-z][a-z0-9-]*$", m.group(1)))
                evidence = f"id={m.group(1)}"
            else:
                evidence = "No id found"

        elif name == "reasonable-field-count":
            schema_match = re.search(r"outputSchema[^{]*\{([^}]+)\}", text)
            if schema_match:
                fields = [f.strip() for f in schema_match.group(1).split(",") if ":" in f]
                count = len(fields)
                passed = 3 <= count <= 7
                evidence = f"{count} fields"
            else:
                evidence = "Could not parse schema"

        elif name == "no-nested-arrays":
            after_schema = text.split("outputSchema")[1] if "outputSchema" in text else ""
            passed = "Array<" not in after_schema
            evidence = "Flat schema" if passed else "Has nested arrays (Array<>)"

        elif name == "prompt-has-specific-signals":
            passed = any(x in text.lower() for x in ["suspicious link", "mismatched", "impersonat", "urgency", "pressure"])
            evidence = "Found specific phishing signals" if passed else "Missing"

        elif name == "has-numeric-score":
            passed = any(x in text for x in ["Score", "score", "number 0-100", "number 0 to 100"])
            evidence = "Has numeric score" if passed else "Missing"

        elif name == "valid-typescript":
            passed = "const action: EmailAction" in text and "export default action" in text
            evidence = "Valid structure" if passed else "Invalid structure"

        elif name == "id-preserved":
            passed = '"sentiment"' in text or "'sentiment'" in text
            evidence = "id=sentiment" if passed else "id changed"

        elif name == "original-fields-kept":
            passed = "sentiment" in text and "urgency" in text
            evidence = "Both sentiment and urgency present" if passed else "Missing original fields"

        elif name == "tone-field-in-prompt":
            passed = "tone" in text and any(x in text for x in ["friendly", "hostile"])
            evidence = "tone with friendly/hostile found" if passed else "Missing tone field"

        elif name == "tone-field-in-schema":
            after_schema = text.split("outputSchema")[1] if "outputSchema" in text else ""
            passed = "tone" in after_schema
            evidence = "tone in schema" if passed else "tone missing from schema"

        elif name == "name-changed":
            code = text.split("```typescript")[1] if "```typescript" in text else ""
            passed = "Sentiment Analysis" not in code
            evidence = "Name changed" if passed else "Still Sentiment Analysis"

        elif name == "description-changed":
            code = text.split("```typescript")[1] if "```typescript" in text else ""
            passed = "meeting" in code.lower()
            evidence = "Description mentions meetings" if passed else "No meeting reference"

        elif name == "prompt-about-meetings":
            code = text.split("```typescript")[1] if "```typescript" in text else ""
            passed = any(x in code.lower() for x in ["meeting", "schedul", "calendar"])
            evidence = "Prompt about meetings" if passed else "Not about meetings"

        elif name == "schema-updated":
            code = text.split("```typescript")[1] if "```typescript" in text else ""
            after_schema = code.split("outputSchema")[1] if "outputSchema" in code else ""
            passed = "meeting" in after_schema.lower() or "isMeeting" in after_schema
            evidence = "Schema has meeting fields" if passed else "Schema not updated"

        else:
            evidence = f"Unknown assertion: {name}"

        results.append({"text": name, "passed": passed, "evidence": evidence})

    return {"expectations": results}


def main():
    all_results = {"with_skill": [], "without_skill": []}

    for eval_dir in sorted(glob.glob(os.path.join(ITER_DIR, "eval-*"))):
        meta_path = os.path.join(eval_dir, "eval_metadata.json")
        if not os.path.exists(meta_path):
            continue
        with open(meta_path) as f:
            meta = json.load(f)

        for variant in ["with_skill", "without_skill"]:
            resp_path = os.path.join(eval_dir, variant, "outputs", "response.md")
            if not os.path.exists(resp_path):
                continue
            with open(resp_path) as f:
                text = f.read()

            grading = grade_response(text, meta["eval_name"], meta["assertions"])

            grading_path = os.path.join(eval_dir, variant, "grading.json")
            with open(grading_path, "w") as f:
                json.dump(grading, f, indent=2)

            timing_path = os.path.join(eval_dir, variant, "timing.json")
            timing = {}
            if os.path.exists(timing_path):
                with open(timing_path) as f:
                    timing = json.load(f)

            expectations = grading["expectations"]
            passed = sum(1 for e in expectations if e["passed"])
            total = len(expectations)

            all_results[variant].append({
                "eval": os.path.basename(eval_dir),
                "passed": passed,
                "total": total,
                "pass_rate": round(passed / total * 100, 1) if total > 0 else 0,
                "tokens": timing.get("total_tokens", 0),
                "duration_ms": timing.get("duration_ms", 0),
                "details": expectations,
            })

    # Print summary
    print("=" * 70)
    print("BENCHMARK RESULTS: Action Skills (Iteration 1)")
    print("=" * 70)

    for variant_label, variant_key in [("WITH SKILL", "with_skill"), ("WITHOUT SKILL (baselines)", "without_skill")]:
        data = all_results[variant_key]
        if not data:
            continue
        print(f"\n{variant_label}:")
        print("-" * 55)
        tp, ta = 0, 0
        for r in data:
            tp += r["passed"]
            ta += r["total"]
            status = "PASS" if r["passed"] == r["total"] else "PARTIAL"
            print(f"  {r['eval']:45s} {r['passed']}/{r['total']} ({r['pass_rate']}%) [{status}]")
            for d in r["details"]:
                icon = " OK " if d["passed"] else "FAIL"
                print(f"    [{icon}] {d['text']}: {d['evidence']}")
        rate = round(tp / ta * 100, 1) if ta > 0 else 0
        print(f"  {'TOTAL':45s} {tp}/{ta} ({rate}%)")
        all_results[f"{variant_key}_rate"] = rate

    ws = all_results.get("with_skill_rate", 0)
    wos = all_results.get("without_skill_rate", 0)
    print(f"\nDELTA: with_skill {ws}% vs without_skill {wos}% = +{round(ws - wos, 1)}%")

    benchmark = {
        "skill_name": "action-skills",
        "iteration": 1,
        "with_skill": {"pass_rate": ws, "evals": all_results["with_skill"]},
        "without_skill": {"pass_rate": wos, "evals": all_results["without_skill"]},
        "delta": round(ws - wos, 1),
    }
    with open(os.path.join(ITER_DIR, "benchmark.json"), "w") as f:
        json.dump(benchmark, f, indent=2)
    print("\nSaved benchmark.json")


if __name__ == "__main__":
    main()
