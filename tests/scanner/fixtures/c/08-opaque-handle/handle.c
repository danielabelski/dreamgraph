/* DreamGraph wave-1 C-5 fixture: opaque handle.
 * `struct Db` is intentionally never defined in this fixture: only the
 * typedef `Database` (a pointer to it) is exposed.
 */
typedef struct Db *Database;

Database db_open(const char *path);
void db_close(Database db);
