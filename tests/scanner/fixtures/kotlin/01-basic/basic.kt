package com.example.app

import kotlin.collections.List
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow
import java.util.Optional
import com.example.legacy.*

@Serializable
data class User(val id: Long, val name: String, val email: String?) {
    companion object {
        const val MAX_NAME = 100
    }
}

sealed interface Event {
    data class Click(val x: Int, val y: Int) : Event
    object Closed : Event
}

interface Repository<T> {
    suspend fun findAll(): List<T>
    fun observe(): Flow<T>
}

@Component
class UserRepository(
    private val users: MutableList<User>,
    private val cache: Map<Long, User>,
) : Repository<User> {
    private val state: StateFlow<User>? = null
    private val maybe: Optional<User> = Optional.empty()

    override suspend fun findAll(): List<User> = users.toList()
    override fun observe(): Flow<User> = throw NotImplementedError()
}

fun String.titleCase(): String = this.replaceFirstChar { it.uppercase() }

fun topLevelHelper(n: Int): Int = n + 1

enum class Status { ACTIVE, INACTIVE }

annotation class Audit(val level: Int = 1)

object AppConfig {
    const val VERSION = "1.0.0"
    val users: List<User> = emptyList()
}
