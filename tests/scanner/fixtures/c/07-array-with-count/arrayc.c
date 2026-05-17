/* DreamGraph wave-1 C-5 fixture: array-with-count + capacity. */
#include <stddef.h>

struct Buffer {
    char *data;
    size_t length;
    size_t capacity;
};

struct IntVec {
    int *items;
    int count;
};
