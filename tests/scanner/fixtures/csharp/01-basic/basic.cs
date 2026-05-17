// basic.cs — C# extractor fixture (CS-1..CS-3)
namespace MyApp.Users;

using System;
using System.Collections.Generic;
using static System.Math;
using ConsoleAlias = System.Console;

public record UserDto(int Id, string Name, string? Email);

public record struct PointR(int X, int Y);

public interface IRepository<T> : IDisposable where T : class
{
    System.Threading.Tasks.Task<List<T>> FindAllAsync();
}

[Serializable, Obsolete]
public abstract partial class BaseEntity
{
    public int Id { get; set; }
}

public sealed class UserRepository : BaseEntity, IRepository<User>
{
    private readonly Dictionary<int, User> _cache = new();
    public List<User> Users { get; init; } = new();
    public User? Maybe { get; set; }
    public required string Name { get; set; }
    public const int MAX = 100;
    public static readonly string VERSION = "1.0";
    public event Action<User>? OnAdded;
    public User[] Snapshot { get; set; } = Array.Empty<User>();

    public UserRepository(IEnumerable<User> seed)
    {
        foreach (var u in seed) _cache[u.Id] = u;
    }

    ~UserRepository() { }

    public async System.Threading.Tasks.Task<List<User>> FindAllAsync() => Users;

    public static UserRepository Empty() { return new UserRepository(Array.Empty<User>()); }

    public void Dispose() { }

    public int this[int i] => i;
}

public enum Status : byte
{
    Active = 1,
    Inactive
}

[AttributeUsage(AttributeTargets.Class)]
public class MarkerAttribute : Attribute { }

public struct Point
{
    public int X;
    public int Y;
}

public readonly struct ROPoint
{
    public int X { get; }
}

public delegate int Transform(int x);

public class User
{
    public required int Id { get; set; }
    public string Name { get; set; } = "";
}
