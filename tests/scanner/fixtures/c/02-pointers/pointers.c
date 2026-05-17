/*
 * DreamGraph wave-1 C-2 fixture: pointer modeling.
 *
 * Exercises:
 *   - depth-1 pointer to a user type    (Node *next)
 *   - depth-2 pointer (pointer-to-pointer)
 *   - const-qualified pointee
 *   - volatile-qualified pointee
 *   - pointer to primitive (char *)
 *   - self-typed pointer (used later by C-4 linked-list shape)
 *   - non-pointer field (must NOT emit POINTS_TO)
 */

typedef struct Node Node;

struct Node {
    int value;
    Node *next;                 /* depth 1, self-ref */
    Node **owner_slot;          /* depth 2 */
    const char *name;           /* depth 1, const pointee */
    volatile int *flag;         /* depth 1, volatile pointee */
    int count;                  /* non-pointer: no POINTS_TO */
};

struct Pair {
    Node *left;
    Node *right;
};
