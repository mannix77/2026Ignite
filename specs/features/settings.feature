Feature: Settings stay as you set them
  Planner settings tune how Gino's plan is built. Whatever value he sees after changing a
  setting is the value the planner keeps, now and after he reopens the app.

  Rule: A tuning value outside its range is held at the nearest limit

    Scenario: Asking for a longer buffer than the planner allows
      Given the longest buffer between sessions is 240 minutes
      When Gino sets the buffer to 300 minutes
      Then the buffer is 240 minutes
      And the buffer is still 240 minutes after he reopens the app

    Scenario: A buffer inside the range is kept as entered
      When Gino sets the buffer to 7 minutes
      Then the buffer is still 7 minutes after he reopens the app
