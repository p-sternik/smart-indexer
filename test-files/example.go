package main

import "fmt"

type Person struct {
    Name string
    Age  int
}

func (p Person) Greet() {
    fmt.Printf("Hello, I'm %s\n", p.Name)
}

func NewPerson(name string, age int) *Person {
    return &Person{Name: name, Age: age}
}

func main() {
    p := NewPerson("Alice", 30)
    p.Greet()
}
