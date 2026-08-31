# Raynard v0.12.1

A bugfix release for chart readability: legends now sit above the plot instead
of overlapping the x-axis.

## Chart legends no longer cover x-axis labels

Multi-series charts previously used Recharts' default bottom legend. On line
charts with enough series or longer labels, the legend could occupy the same
space as the x-axis and obscure its labels.

Legends now use the chart's top alignment. Recharts reserves plot space for the
legend there, keeping the x-axis clear while preserving the existing controls
for hiding and restoring individual series.
