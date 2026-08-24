"""Assert the Python schema mirror matches the canonical TS<->Python contract (#123).

The contract artifact (`contracts/preference-example.contract.json`) is generated
from the TypeScript source of truth (`preference-export.ts` + `findings.ts`) and
committed. This test makes `python/preference-dataset/schema.py` fail loudly if it
drifts from that artifact, field-for-field and enum-for-enum, and checks that this
module's `canonical_json` is byte-identical to the samples the real `dvc-export.ts`
serializer produced. A deliberate TS enum/field change therefore breaks BOTH the
TS regen check and this pytest, which is the point.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Literal, Union, get_args, get_origin

import pytest

from preference_dataset import schema
from preference_dataset.reader import canonical_json
from preference_dataset.schema import Finding, PreferenceExample

CONTRACT_PATH = (
    Path(__file__).resolve().parents[3] / "contracts" / "preference-example.contract.json"
)

# Enum aliases in schema.py, keyed by the name the contract uses.
SCHEMA_ENUMS = {
    "Dimension": schema.Dimension,
    "Severity": schema.Severity,
    "Viewport": schema.Viewport,
    "Verdict": schema.Verdict,
    "Label": schema.Label,
    "KtoSource": schema.KtoSource,
}

SCHEMA_TYPES = {"PreferenceExample": PreferenceExample, "Finding": Finding}


@pytest.fixture(scope="module")
def contract() -> dict[str, Any]:
    assert CONTRACT_PATH.exists(), (
        f"contract artifact missing at {CONTRACT_PATH}; regenerate with "
        "`pnpm --filter @apatureai/verdict-feedback contract:gen`"
    )
    return json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))


def _unwrap(annotation: Any) -> tuple[Any, bool]:
    """Strip an Optional/Union[..., None] wrapper: return (core, allows_none)."""
    if get_origin(annotation) is Union:
        args = get_args(annotation)
        non_none = [a for a in args if a is not type(None)]
        allows_none = type(None) in args
        core = non_none[0] if len(non_none) == 1 else Union[tuple(non_none)]
        return core, allows_none
    return annotation, False


def _literal_members(core: Any) -> list[str] | None:
    return list(get_args(core)) if get_origin(core) is Literal else None


def test_enums_match_contract(contract: dict[str, Any]) -> None:
    # No enum in the contract is silently unmirrored, and vice versa.
    assert set(contract["enums"]) == set(SCHEMA_ENUMS)
    for name, literal in SCHEMA_ENUMS.items():
        assert list(get_args(literal)) == contract["enums"][name], name


def test_field_names_match_contract(contract: dict[str, Any]) -> None:
    for type_name, model in SCHEMA_TYPES.items():
        expected = [f["name"] for f in contract["types"][type_name]["fields"]]
        assert list(model.model_fields.keys()) == expected, type_name


def test_field_shapes_match_contract(contract: dict[str, Any]) -> None:
    for type_name, model in SCHEMA_TYPES.items():
        for field in contract["types"][type_name]["fields"]:
            info = model.model_fields[field["name"]]
            core, allows_none = _unwrap(info.annotation)

            if field["kind"] == "enum":
                # The field's Literal members must equal the referenced enum.
                assert _literal_members(core) == contract["enums"][field["enum"]], (
                    type_name,
                    field["name"],
                )

            if field["name"] == "source":
                # DELIBERATE divergence (#127): the TS interface declares `source`
                # required + non-null, but schema.py relaxes it to Optional so the
                # DVC-export test-factory shape (which omits it) still parses. #127
                # was resolved at the content-addressing layer, NOT by tightening
                # this field: a source-omitted tuple hashes without a `source` key
                # (see `reader.dvc_content`), so `source` stays Optional by design.
                # This assertion pins that reconciliation.
                assert allows_none is True
                assert info.is_required() is False
                continue

            # Everywhere else, Python admits None exactly when TS is nullable/optional.
            expected_none = field["nullable"] or field["optional"]
            assert allows_none is expected_none, (type_name, field["name"])


def test_canonical_json_byte_matches_dvc_export(contract: dict[str, Any]) -> None:
    # The pinned strings came from dvc-export.ts `canonicalJson`; parsing a sample
    # through the Python schema and re-serializing must reproduce them byte-for-byte.
    assert contract["canonicalSamples"], "expected pinned canonical samples"
    for sample in contract["canonicalSamples"]:
        example = PreferenceExample.model_validate(sample["example"])
        assert canonical_json(example.model_dump()) == sample["canonicalJson"], sample[
            "name"
        ]
