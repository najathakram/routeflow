"""Batched blast-radius lookup for scripts/graph.mjs.

One graph load for all symbols, through graphify's own helpers (load_graph / resolve_seed /
affected_nodes). Run with graphify's interpreter:  python -I -X utf8 graph-radius.py < request.json

stdin : {"graph": path, "symbols": [{"raw", "name", "file"?}], "relations": [...], "depth": 2}
stdout: {"nodes": N, "edges": E, "results": [
          {"symbol", "status": "ok"|"ambiguous"|"notfound", "seed", "label", "defFile", "defLoc",
           "hits": [{"file", "loc", "rel", "depth", "label"}], "candidates": [{"id","label","file","loc"}]}]}
"""
import json
import sys
from pathlib import Path

from graphify.affected import affected_nodes, load_graph, resolve_seed

MAX_CANDIDATES = 15


def _norm(text):
    text = str(text or "").replace("\\", "/")
    return (text[2:] if text.startswith("./") else text).casefold()


def _bare(label):
    label = str(label or "").casefold().lstrip(".")  # methods are labelled ".name()"
    return label[:-2] if label.endswith("()") else label


def _cand(graph, node_id):
    data = graph.nodes[node_id]
    return {
        "id": str(node_id),
        "label": str(data.get("label") or node_id),
        "file": str(data.get("source_file") or ""),
        "loc": str(data.get("source_location") or ""),
    }


def _name_candidates(graph, name):
    want = _bare(name)
    exact = [n for n, d in graph.nodes(data=True) if _bare(d.get("label")) == want]
    if exact:
        return exact
    return [n for n, d in graph.nodes(data=True) if want and want in _bare(d.get("label"))]


def _resolve(graph, spec, root):
    """-> (seed | None, candidates[])."""
    file = spec.get("file")
    name = spec["name"]
    if file:
        want = _norm(file)
        found = [
            n
            for n in _name_candidates(graph, name)
            if _norm(graph.nodes[n].get("source_file")) == want
            or _norm(graph.nodes[n].get("source_file")).endswith("/" + want)
        ]
        return (found[0], []) if len(found) == 1 else (None, found)
    seed = resolve_seed(graph, name, root)
    if seed is not None:
        return seed, []
    return None, _name_candidates(graph, name)


def main():
    req = json.load(sys.stdin)
    graph_path = Path(req["graph"])
    graph = load_graph(graph_path)
    root = graph_path.parent.parent
    relations = tuple(req.get("relations") or ("calls", "indirect_call", "references"))
    depth = int(req.get("depth", 2))
    results = []
    for spec in req["symbols"]:
        res = {"symbol": spec["raw"], "status": "notfound", "hits": [], "candidates": []}
        seed, cands = _resolve(graph, spec, root)
        if seed is not None:
            data = graph.nodes[seed]
            res.update(
                status="ok",
                seed=str(seed),
                label=str(data.get("label") or seed),
                defFile=str(data.get("source_file") or ""),
                defLoc=str(data.get("source_location") or ""),
            )
            for hit in affected_nodes(graph, seed, relations=relations, depth=depth):
                hdata = graph.nodes[hit.node_id]
                res["hits"].append(
                    {
                        "file": hit.via_file or str(hdata.get("source_file") or ""),
                        "loc": hit.via_location or str(hdata.get("source_location") or ""),
                        "rel": hit.via_relation,
                        "depth": hit.depth,
                        "label": str(hdata.get("label") or hit.node_id),
                    }
                )
        elif cands:
            res["status"] = "ambiguous"
            res["candidateCount"] = len(cands)
            res["candidates"] = [
                _cand(graph, n)
                for n in sorted(cands, key=lambda n: (str(graph.nodes[n].get("source_file")), str(n)))[:MAX_CANDIDATES]
            ]
        results.append(res)
    json.dump(
        {"nodes": graph.number_of_nodes(), "edges": graph.number_of_edges(), "results": results},
        sys.stdout,
    )


if __name__ == "__main__":
    main()
