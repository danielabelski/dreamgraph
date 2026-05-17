/*
 * DreamGraph wave-1 C-1 fixture: basic structs, enums, typedefs,
 * function declarations, function definitions, macros, includes.
 *
 * The matching snapshot test in tests/scanner/c-extractor.test.ts
 * pins the extractor's output for this file. If you change the
 * extractor's emit shape, regenerate snapshots with
 * `npx vitest run tests/scanner/c-extractor.test.ts -u`.
 */

#include <stdio.h>
#include "internal.h"

#define MAX_NODES 64
#define LIST_FOREACH(it, head) for ((it) = (head); (it); (it) = (it)->next)

typedef enum {
    NODE_KIND_LEAF = 0,
    NODE_KIND_BRANCH = 1
} NodeKind;

typedef struct Node {
    int value;
    NodeKind kind;
} Node;

struct Bucket {
    unsigned int hash;
    Node *first;
};

union Payload {
    int as_int;
    float as_float;
};

/* Function prototype (header-style). */
int node_count(const struct Bucket *bucket);

/* Function definition (body present). */
Node node_make(int value) {
    Node n;
    n.value = value;
    n.kind = NODE_KIND_LEAF;
    return n;
}
