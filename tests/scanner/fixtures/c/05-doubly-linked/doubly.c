/* DreamGraph wave-1 C-4 fixture: doubly-linked list. */
typedef struct DNode DNode;

struct DNode {
    int value;
    DNode *next;
    DNode *prev;
};
