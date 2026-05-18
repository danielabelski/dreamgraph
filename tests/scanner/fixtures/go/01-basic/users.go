// Package users models a tiny user repository used as a Go extractor fixture.
// The constructs here exercise every GO-1..GO-3 feature: imports (named,
// dot, blank), defined types vs aliases, struct fields with pointer /
// slice / map / chan / func / embedded shapes, struct tags, interface
// method specs with embedded constraints, package-level const + var,
// and methods with both value and pointer receivers.
package users

import (
	"fmt"
	"io"

	myio "io/ioutil"
	. "errors"
	_ "github.com/lib/pq"
)

// ID is an alias — same type as int.
type ID = int

// Name is a defined type — distinct from string at the type level.
type Name string

// Transform is a function-typed type alias (delegate-like).
type Transform func(in []byte) ([]byte, error)

// User is the central record type. Field shapes cover the full
// classification matrix used by the extractor.
type User struct {
	ID       ID                `json:"id" db:"id"`
	Name     Name              `json:"name"`
	Next     *User             `json:"-"`
	Friends  []*User           `json:"friends"`
	Tags     []string          `json:"tags"`
	Index    [16]byte
	Lookup   map[string]*Group `json:"lookup"`
	Events   chan string
	Inbound  <-chan int
	Outbound chan<- bool
	OnLogin  func(*User) error
	Profile  struct {
		Bio string
	}
	Embeddable
	*GroupRef
}

// Embeddable is embedded into User by value to test embedded-field
// promotion + EMBEDS edge emission.
type Embeddable struct {
	CreatedAt int64
}

// GroupRef is embedded as a pointer.
type GroupRef struct {
	Group *Group
}

// Group is referenced from User.Lookup and from GroupRef.
type Group struct {
	Members []*User
}

// Repository describes the persistence surface.
type Repository interface {
	Get(id ID) (*User, error)
	Save(u *User) error
	io.Closer
}

// MAX is a package-scoped integer constant.
const MAX = 100

// Grouped const block.
const (
	StatusActive  = "active"
	StatusBlocked = "blocked"
)

// count is a package-level variable.
var count int = 0

// NewUser is a package-level constructor function.
func NewUser(name Name) *User {
	return &User{Name: name}
}

// Walk has a pointer receiver and a higher-order parameter.
func (u *User) Walk(visit func(*User)) error {
	if u == nil {
		return New("nil user")
	}
	for _, f := range u.Friends {
		visit(f)
	}
	return nil
}

// Greet has a value receiver and returns multiple values.
func (u User) Greet() (string, error) {
	return fmt.Sprintf("hi %s", u.Name), nil
}

// HelperUnused exercises blank-aliased import side-effects.
func HelperUnused() {
	_ = myio.Discard
}
