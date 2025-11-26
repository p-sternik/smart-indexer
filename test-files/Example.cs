using System;

namespace Example
{
    public class Calculator
    {
        private int result;
        
        public Calculator()
        {
            result = 0;
        }
        
        public int Add(int a, int b)
        {
            result = a + b;
            return result;
        }
        
        public void PrintResult()
        {
            Console.WriteLine($"Result: {result}");
        }
    }
    
    public interface IOperation
    {
        int Execute(int a, int b);
    }
    
    public struct Point
    {
        public int X { get; set; }
        public int Y { get; set; }
    }
}
